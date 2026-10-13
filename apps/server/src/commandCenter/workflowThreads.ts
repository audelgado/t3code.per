import {
  CommandCenterError,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  delegatedTaskProgress,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { failWith } from "./CommandCenterService.ts";

/** How a workflow step's thread ended: whether its turn completed, and its final reply or error. */
export interface WorkflowThreadResult {
  readonly ok: boolean;
  readonly text: string;
}

export interface WorkflowThreadLaunch {
  /** Stable per step attempt: a relaunch with the same key replays the first launch. */
  readonly key: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
}

/**
 * The threads a workflow run starts, on the paths every other server-side launch uses: a launch
 * like a scheduled task's, a settle wait like `delegate_task`'s (it re-reads the thread only when
 * one of its run, task or background-work events lands), and Stop.
 */
export class WorkflowThreads extends Context.Service<
  WorkflowThreads,
  {
    readonly launch: (input: WorkflowThreadLaunch) => Effect.Effect<ThreadId, CommandCenterError>;
    /** Resolves when the thread's work is done: its turns ended and nothing it started still runs. */
    readonly awaitSettled: (
      threadId: ThreadId,
    ) => Effect.Effect<WorkflowThreadResult, CommandCenterError>;
    readonly stop: (threadId: ThreadId, key: string) => Effect.Effect<void, CommandCenterError>;
    /** The thread's worktree once it exists; null for a thread in the project checkout. */
    readonly worktree: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly path: string; readonly branch: string | null } | null>;
  }
>()("t3/commandCenter/workflowThreads") {}

const WAKE_EVENTS = [
  "run.updated",
  "subagent.updated",
  "provider-thread.updated",
  "thread.deleted",
] as const satisfies ReadonlyArray<OrchestrationV2DomainEvent["type"]>;
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

type Done = { readonly state: "done"; readonly result: WorkflowThreadResult };
type Progress = { readonly state: "working" | "waiting_for_children" } | Done;
const isDone = (progress: Progress): progress is Done => progress.state === "done";
const isCommandCenterError = Schema.is(CommandCenterError);

export const make = Effect.gen(function* () {
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const launch = (input: WorkflowThreadLaunch) =>
    threadLaunch
      .launch({
        commandId: CommandId.make(`workflow-step:${input.key}`),
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        workspaceStrategy: input.workspace,
        initialMessage: {
          messageId: MessageId.make(`workflow-step-message:${input.key}`),
          text: input.prompt,
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.map((result) => result.threadId),
        Effect.mapError(
          (error) => new CommandCenterError({ message: error.message, cause: error }),
        ),
      );

  const readProgress = Effect.fn("WorkflowThreads.readProgress")(function* (threadId: ThreadId) {
    const controls = yield* threads.getThreadRecords(
      threadId,
      ["runs", "messages", "subagents", "providerThreads"],
      { messageRoles: ["user"] },
    );
    const progress = delegatedTaskProgress(controls);
    if (progress.state !== "result_available" || progress.resultRun === undefined) {
      return {
        state: progress.state === "result_available" ? "working" : progress.state,
      } satisfies Progress;
    }
    const run = progress.resultRun;
    const records = yield* threads.getThreadRecords(threadId, ["messages", "turnItems"], {
      messageRoles: ["assistant"],
      messageRunIds: [run.id],
      turnItemRunIds: [run.id],
      turnItemTypes: ["assistant_message", "error"],
    });
    return {
      state: "done",
      result: { ok: run.status === "completed", text: subagentResultForRun(records, run).text },
    } satisfies Progress;
  });

  const awaitSettled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      // Taken before the first read, so an event between that read and the streams still replays.
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      let last: Progress = yield* readProgress(threadId);
      if (isDone(last)) return last.result;
      // One stream per event type, so transcript events never fill a buffer.
      const settled = yield* Stream.mergeAll(
        WAKE_EVENTS.map((eventType) =>
          threads.streamStoredEventsFrom({ threadId, afterSequence, eventType }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        // A run that has not ended, or task news while the turn still runs, changes nothing.
        Stream.filter(
          ({ event }) =>
            event.type === "thread.deleted" ||
            (event.type === "run.updated"
              ? TERMINAL_RUN.has(event.payload.status)
              : last.state === "waiting_for_children"),
        ),
        Stream.mapEffect(({ event }) =>
          Effect.gen(function* () {
            if (event.type === "thread.deleted") {
              return yield* new CommandCenterError({ message: "The step's thread was deleted." });
            }
            last = yield* readProgress(threadId);
            return last;
          }),
        ),
        Stream.filter(isDone),
        Stream.runHead,
      );
      if (Option.isNone(settled)) {
        return yield* new CommandCenterError({ message: "Stopped watching the step's thread." });
      }
      return settled.value.result;
    }).pipe(
      Effect.mapError((error) =>
        isCommandCenterError(error)
          ? error
          : failWith("Could not follow the step's thread.")(error),
      ),
    );

  const stop = (threadId: ThreadId, key: string) =>
    Effect.gen(function* () {
      const commandId = CommandId.make(`workflow-step-stop:${key}`);
      yield* threads.dispatch({ type: "thread.stop", commandId, threadId });
      // Like task_cancel: what the step delegated stops with it.
      yield* threads.stopDelegatedTasks({ threadId, commandId });
    }).pipe(Effect.mapError(failWith("Could not stop the step's thread.")));

  const worktree = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.map((shell) =>
        shell == null || shell.worktreePath === null
          ? null
          : { path: shell.worktreePath, branch: shell.branch },
      ),
      Effect.orElseSucceed(() => null),
    );

  return WorkflowThreads.of({ launch, awaitSettled, stop, worktree });
});

export const layer = Layer.effect(WorkflowThreads, make);
