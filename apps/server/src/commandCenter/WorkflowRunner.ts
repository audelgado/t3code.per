import {
  COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT,
  CommandCenterAgentProfile,
  CommandCenterError,
  CommandCenterSnippetName,
  CommandCenterWorkflow,
  CommandCenterWorkflowRun,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowRunListResult,
  CommandCenterWorkflowSlug,
  CommandCenterWorkflowStep,
  parseWorkflowCommand,
  planWorkflowInputs,
  validateCommandCenterWorkflow,
  type CommandCenterWorkflowAnswerStepInput,
  type CommandCenterWorkflowInput,
  type CommandCenterWorkflowNode,
  type CommandCenterWorkflowNodeId,
  type CommandCenterWorkflowParallelNode,
  type CommandCenterWorkflowRetryStepInput,
  type CommandCenterWorkflowRunDetail,
  type CommandCenterWorkflowRunListInput,
  type CommandCenterWorkflowRunRef,
  type CommandCenterWorkflowRunStartInput,
  type CommandCenterWorkflowRunStatus,
  type CommandCenterWorkflowRunStreamEvent,
  type CommandCenterWorkflowRunSubscribeInput,
  type CommandCenterWorkflowStepStatus,
  type ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { clampDispatchModes, type DispatchModes } from "../orchestration-v2/DispatchModeLimit.ts";
import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ArtifactsService from "./ArtifactsService.ts";
import * as CommandCenterService from "./CommandCenterService.ts";
import { decodeRows, failWith, fromRow, toRow } from "./CommandCenterService.ts";
import {
  ScheduledTaskPromptRoutes,
  type ScheduledPrompt,
} from "../scheduledTasks/ScheduledTaskPromptRoutes.ts";
import { WORKFLOW_STARTERS } from "./workflowStarters.ts";
import { WorkflowThreads, type WorkflowThreadResult } from "./workflowThreads.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

export interface WorkflowRunStartOptions {
  /**
   * The broadest modes the run's threads may use, for runs an agent or a scheduled task starts:
   * a step's profile or the server default steps down to it. Omitted for the user's own runs.
   */
  readonly modeLimit?: DispatchModes | undefined;
}

/**
 * Wave 5: runs workflow graphs (docs/command-center/WORKFLOWS.md). Each agent, skill and check
 * step is a normal thread; the runner advances when a thread settles, on the events the server
 * already records. No polling and no model in the runner. Runs live in SQLite on this server,
 * so a restart picks them up from `cc_workflow_steps`.
 */
export class WorkflowRunner extends Context.Service<
  WorkflowRunner,
  {
    /**
     * Snapshots the workflow and inputs, then runs the graph from its first nodes. A slug with no
     * file in the project runs the built-in starter of that name.
     */
    readonly start: (
      input: CommandCenterWorkflowRunStartInput,
      options?: WorkflowRunStartOptions,
    ) => Effect.Effect<CommandCenterWorkflowRun, CommandCenterError>;
    /** Stops every open step and its thread; finished steps stay. */
    readonly stop: (
      input: CommandCenterWorkflowRunRef,
    ) => Effect.Effect<CommandCenterWorkflowRun, CommandCenterError>;
    /** Runs a failed or stopped step again as a new attempt, then continues the run. */
    readonly retryStep: (
      input: CommandCenterWorkflowRetryStepInput,
    ) => Effect.Effect<CommandCenterWorkflowRun, CommandCenterError>;
    /** Continues a stopped or failed run: every failed or stopped step gets a new attempt. */
    readonly resume: (
      input: CommandCenterWorkflowRunRef,
    ) => Effect.Effect<CommandCenterWorkflowRun, CommandCenterError>;
    /**
     * Answers a waiting ask, or passes or fails a manual gate. With choices, the first one
     * continues the run and any other stops it there (resume asks again).
     */
    readonly answer: (
      input: CommandCenterWorkflowAnswerStepInput,
    ) => Effect.Effect<CommandCenterWorkflowRun, CommandCenterError>;
    readonly list: (
      input: CommandCenterWorkflowRunListInput,
    ) => Effect.Effect<CommandCenterWorkflowRunListResult, CommandCenterError>;
    readonly get: (
      input: CommandCenterWorkflowRunRef,
    ) => Effect.Effect<CommandCenterWorkflowRunDetail, CommandCenterError>;
    /** A snapshot, then every run and step change. Fails while Command Center is off. */
    readonly subscribe: (
      input: CommandCenterWorkflowRunSubscribeInput,
    ) => Stream.Stream<CommandCenterWorkflowRunStreamEvent, CommandCenterError>;
  }
>()("t3/commandCenter/WorkflowRunner") {}

type Row = Record<string, unknown>;

const decodeRunPage = Schema.decodeUnknownEffect(CommandCenterWorkflowRunListResult);
const decodeSteps = Schema.decodeUnknownEffect(Schema.Array(CommandCenterWorkflowStep));
const decodeDetail = Schema.decodeUnknownEffect(
  Schema.Struct({
    run: CommandCenterWorkflowRun,
    steps: Schema.Array(CommandCenterWorkflowStep),
    workflow: CommandCenterWorkflow,
  }),
);
const decodeAgentProfile = Schema.decodeUnknownEffect(CommandCenterAgentProfile);
const encodeWorkflow = Schema.encodeSync(CommandCenterWorkflow);
const decodeSnippetName = Schema.decodeUnknownOption(CommandCenterSnippetName);
const decodeSlug = Schema.decodeUnknownOption(CommandCenterWorkflowSlug);

type RunChange =
  | { readonly type: "run"; readonly run: CommandCenterWorkflowRun }
  | {
      readonly type: "step";
      readonly projectId: ProjectId;
      readonly step: CommandCenterWorkflowStep;
    };

/** Run persistence and change feed. */
export const makeWorkflowRunStore = Effect.gen(function* () {
  // Creates the cc_ tables before the first query.
  yield* CommandCenterService.CommandCenterService;
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  // Unbounded: subscribers fold every change in order, so dropping one would desync them.
  const changes = yield* PubSub.unbounded<RunChange>();

  const list = Effect.fn("WorkflowRunStore.list")(function* (
    input: CommandCenterWorkflowRunListInput,
  ) {
    const limit = input.limit ?? 20;
    const rows = yield* sql<Row>`
      SELECT * FROM cc_workflow_runs
      WHERE ${sql.and([
        ...(input.projectId === undefined ? [] : [sql`project_id = ${input.projectId}`]),
        ...(input.slug === undefined ? [] : [sql`slug = ${input.slug}`]),
        ...(input.before === undefined
          ? []
          : [
              sql`(started_at, id) < (
                (SELECT started_at FROM cc_workflow_runs WHERE id = ${input.before}),
                ${input.before}
              )`,
            ]),
      ])}
      ORDER BY started_at DESC, id DESC
      LIMIT ${limit + 1}
    `.pipe(Effect.mapError(failWith("Could not list workflow runs.")));
    return yield* decodeRows("Could not list workflow runs.", decodeRunPage, () => ({
      runs: rows.slice(0, limit).map(fromRow),
      hasMore: rows.length > limit,
    }));
  });

  const get = Effect.fn("WorkflowRunStore.get")(function* (input: CommandCenterWorkflowRunRef) {
    const [run] = yield* sql<Row>`SELECT * FROM cc_workflow_runs WHERE id = ${input.runId}`.pipe(
      Effect.mapError(failWith("Could not read the workflow run.")),
    );
    if (run === undefined) {
      return yield* new CommandCenterError({ message: "Workflow run not found." });
    }
    const steps = yield* sql<Row>`
      SELECT * FROM cc_workflow_steps WHERE run_id = ${input.runId}
      ORDER BY COALESCE(started_at, updated_at), id
    `.pipe(Effect.mapError(failWith("Could not read the workflow run.")));
    return yield* decodeRows("Could not read the workflow run.", decodeDetail, () => {
      const value = fromRow(run);
      return { run: value, steps: steps.map(fromRow), workflow: value.workflow };
    });
  });

  const snapshot = Effect.fn("WorkflowRunStore.snapshot")(function* (
    input: CommandCenterWorkflowRunSubscribeInput,
  ) {
    const { runs } = yield* list({
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      limit: COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT,
    });
    const open = runs.filter((run) => run.finishedAt === null).map((run) => run.id);
    const steps =
      open.length === 0
        ? []
        : yield* sql<Row>`
            SELECT * FROM cc_workflow_steps WHERE run_id IN ${sql.in(open)}
            ORDER BY COALESCE(started_at, updated_at), id
          `.pipe(
            Effect.mapError(failWith("Could not read the workflow runs.")),
            Effect.flatMap((rows) =>
              decodeRows("Could not read the workflow runs.", decodeSteps, () => rows.map(fromRow)),
            ),
          );
    return { type: "snapshot", runs, steps } satisfies CommandCenterWorkflowRunStreamEvent;
  });

  const subscribe = (input: CommandCenterWorkflowRunSubscribeInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const enabled = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.commandCenter.enabled),
          Effect.mapError(failWith("Could not read the Command Center setting.")),
        );
        if (!enabled) {
          return yield* new CommandCenterError({
            message: "Command Center is turned off on this server (commandCenter.enabled).",
          });
        }
        // Subscribe before the snapshot so a change landing between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (change) =>
              input.projectId === undefined ||
              (change.type === "run" ? change.run.projectId : change.projectId) === input.projectId,
          ),
          Stream.map((change): CommandCenterWorkflowRunStreamEvent =>
            change.type === "run"
              ? { type: "run", run: change.run }
              : { type: "step", step: change.step },
          ),
        );
        return Stream.concat(Stream.fromEffect(snapshot(input)), live);
      }),
    );

  /** Inserts or updates a run; the workflow snapshot and mode limit are written once, on insert. */
  const saveRun = Effect.fn("WorkflowRunStore.saveRun")(function* (
    run: CommandCenterWorkflowRun,
    workflow: CommandCenterWorkflow,
    modeLimit: DispatchModes | null = null,
  ) {
    const row = {
      ...toRow({ ...run, workflow: encodeWorkflow(workflow) }),
      mode_limit: modeLimit === null ? null : encodeModeLimit(modeLimit),
    };
    yield* sql`
      INSERT INTO cc_workflow_runs ${sql.insert(row)}
      ON CONFLICT (id) DO UPDATE SET
        status = excluded.status,
        error = excluded.error,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(failWith("Could not save the workflow run.")));
    yield* PubSub.publish(changes, { type: "run", run });
    return run;
  });

  const saveStep = Effect.fn("WorkflowRunStore.saveStep")(function* (
    projectId: ProjectId,
    step: CommandCenterWorkflowStep,
  ) {
    const row = toRow(step);
    yield* sql`
      INSERT INTO cc_workflow_steps ${sql.insert(row)}
      ON CONFLICT (id) DO UPDATE SET
        thread_id = excluded.thread_id,
        status = excluded.status,
        output = excluded.output,
        error = excluded.error,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(failWith("Could not save the workflow step.")));
    yield* PubSub.publish(changes, { type: "step", projectId, step });
    return step;
  });

  return { list, get, subscribe, saveRun, saveStep };
});

// ---------------------------------------------------------------------------------------------
// Graph and text helpers (pure)

type Run = CommandCenterWorkflowRun;
type Step = CommandCenterWorkflowStep;
type Node = CommandCenterWorkflowNode;
type ThreadNode = Extract<Node, { readonly kind: "agent" | "skill" | "gate" }>;

/** The step output limit (`CommandCenterWorkflowStep.output`); a handoff is never longer. */
const OUTPUT_LIMIT = 2_000;
/** Most text the steps before one hand it, so a long chain never floods a prompt. */
const HANDOFF_LIMIT = 8_000;
/** Children of one parallel node that run at once. */
export const PARALLEL_CONCURRENCY = 3;
/** Most items one parallel node fans out over. */
export const PARALLEL_ITEM_LIMIT = 50;

const FINISHED_RUN: ReadonlySet<CommandCenterWorkflowRunStatus> = new Set([
  "succeeded",
  "failed",
  "stopped",
]);
const OPEN_STEP: ReadonlySet<CommandCenterWorkflowStepStatus> = new Set([
  "pending",
  "running",
  "waiting",
]);
const RETRYABLE_STEP: ReadonlySet<CommandCenterWorkflowStepStatus> = new Set(["failed", "stopped"]);

export const clip = (text: string, limit = OUTPUT_LIMIT) => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
};

/** The end of a reply, where a check states its verdict. */
const clipTail = (text: string, limit = OUTPUT_LIMIT) => {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…${trimmed.slice(trimmed.length - limit + 1)}` : trimmed;
};

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * Items for a parallel node: a JSON array, else the bullet lines of the text (every line when
 * it has none), capped at `PARALLEL_ITEM_LIMIT`.
 */
/** A run's mode limit and a step's item list, as stored in their TEXT columns. */
const ModeLimitJson = Schema.fromJsonString(
  Schema.Struct({ runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode }),
);
const ItemsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeModeLimit = Schema.encodeSync(ModeLimitJson);
const encodeItems = Schema.encodeSync(ItemsJson);
const decodeItems = Schema.decodeUnknownOption(ItemsJson);
const decodeModeLimitJson = Schema.decodeUnknownOption(ModeLimitJson);

export function parseItems(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item : JSON.stringify(item)).trim())
          .filter((item) => item.length > 0)
          .slice(0, PARALLEL_ITEM_LIMIT);
      }
    } catch {
      // Not JSON: read it as lines.
    }
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const bullets = lines.filter((line) => BULLET.test(line));
  return (bullets.length > 0 ? bullets : lines)
    .map((line) => line.replace(BULLET, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, PARALLEL_ITEM_LIMIT);
}

/** A check passes when the last line of its reply is PASS. */
export const checkPassed = (text: string) =>
  /^[\s*_`]*PASS\b/i.test(text.trim().split(/\r?\n/).at(-1) ?? "");

const SNIPPET_REFERENCE = /\{\{snippet:([^}]*)\}\}/g;
const INPUT_REFERENCE = /\{\{input:([^}]*)\}\}/g;

export const snippetReferences = (text: string) => [
  ...new Set(Array.from(text.matchAll(SNIPPET_REFERENCE), (match) => (match[1] ?? "").trim())),
];

/** Fills `{{snippet:name}}` (first, so snippets may use inputs), `{{input:name}}` and `{{item}}`. */
export const fillTemplate = (
  text: string,
  values: {
    readonly inputs: Readonly<Record<string, string>>;
    readonly snippets: ReadonlyMap<string, string>;
    readonly item?: string | undefined;
  },
) =>
  text
    .replace(SNIPPET_REFERENCE, (_, name: string) => values.snippets.get(name.trim()) ?? "")
    .replace(INPUT_REFERENCE, (_, name: string) => values.inputs[name.trim()] ?? "")
    // A function, so `$&` and `$$` in an item stay as typed.
    .replaceAll("{{item}}", () => values.item ?? "");

/** Declared inputs with their defaults; refuses unknown names and missing values. */
export function resolveInputs(
  declared: ReadonlyArray<CommandCenterWorkflowInput>,
  given: Readonly<Record<string, string>> = {},
): { readonly inputs: Record<string, string> } | { readonly error: string } {
  const names = declared.map((input) => input.name);
  const unknown = Object.keys(given).filter((name) => !names.includes(name));
  if (unknown.length > 0) {
    return {
      error: `Unknown input ${unknown.map((name) => `"${name}"`).join(", ")}; this workflow takes ${names.length === 0 ? "no inputs" : names.map((name) => `"${name}"`).join(", ")}.`,
    };
  }
  const inputs: Record<string, string> = {};
  const missing: string[] = [];
  for (const input of declared) {
    const value = given[input.name]?.trim() || input.default;
    if (value === undefined || value === "") missing.push(input.name);
    else inputs[input.name] = value;
  }
  return missing.length > 0
    ? { error: `Give a value for ${missing.map((name) => `"${name}"`).join(", ")}.` }
    : { inputs };
}

interface RunGraph {
  readonly nodes: ReadonlyMap<string, Node>;
  /** A parallel body's id to the parallel node that runs it. */
  readonly parentOf: ReadonlyMap<string, CommandCenterWorkflowParallelNode>;
  /** Nodes outside parallel bodies, each after the nodes it waits for. */
  readonly order: ReadonlyArray<Node>;
  readonly incoming: ReadonlyMap<string, ReadonlyArray<string>>;
  /** What a node waits for: its incoming edges, and the node a parallel runs over. */
  readonly deps: ReadonlyMap<string, ReadonlyArray<string>>;
}

const buildGraph = (workflow: CommandCenterWorkflow): RunGraph => {
  const nodes = new Map(workflow.nodes.map((node) => [node.id as string, node]));
  const inputs = new Set(workflow.inputs.map((input) => input.name));
  const parentOf = new Map<string, CommandCenterWorkflowParallelNode>();
  for (const node of workflow.nodes) if (node.kind === "parallel") parentOf.set(node.node, node);
  const incoming = new Map<string, string[]>();
  for (const { from, to } of workflow.edges) incoming.set(to, [...(incoming.get(to) ?? []), from]);
  const deps = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    const over =
      node.kind === "parallel" && !inputs.has(node.over) && nodes.has(node.over) ? [node.over] : [];
    deps.set(node.id, [...(incoming.get(node.id) ?? []), ...over]);
  }
  // Depth-first, dependencies first; the graph was validated acyclic.
  const order: Node[] = [];
  const seen = new Set<string>();
  const visit = (node: Node) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    for (const id of deps.get(node.id) ?? []) {
      const dep = nodes.get(id);
      if (dep !== undefined) visit(dep);
    }
    order.push(node);
  };
  for (const node of workflow.nodes) if (!parentOf.has(node.id)) visit(node);
  return { nodes, parentOf, order, incoming, deps };
};

const stepKey = (nodeId: string, item: number | null) =>
  item === null ? nodeId : `${nodeId}#${item}`;

const latestSteps = (steps: ReadonlyArray<Step>) => {
  const latest = new Map<string, Step>();
  for (const step of steps) {
    const key = stepKey(step.nodeId, step.item);
    const current = latest.get(key);
    if (current === undefined || step.attempt > current.attempt) latest.set(key, step);
  }
  return latest;
};

const nodeTitle = (node: Node | undefined, fallback = "") => node?.title ?? node?.id ?? fallback;

const gateInstruction = (check: "tests" | "typecheck") =>
  `Run this project's ${check === "tests" ? "tests" : "type check"}, scoped to what changed when a full run is slow. Do not edit any files. End your reply with one line: PASS if everything passes, or FAIL and a one-sentence reason.`;

const causeMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// ---------------------------------------------------------------------------------------------
// Executor

/**
 * One run while the runner holds its lock: the stored run plus the newest step per node.
 * Saving a step updates `latest`, so loops that save iterate a copy of it.
 */
interface Pass {
  run: Run;
  readonly workflow: CommandCenterWorkflow;
  readonly graph: RunGraph;
  readonly latest: Map<string, Step>;
  /** The run's mode ceiling; null for the user's own runs. */
  readonly modeLimit: DispatchModes | null;
  /** By step id: the full item list of a step a parallel node runs over. */
  readonly items: Map<string, ReadonlyArray<string>>;
}

interface FanOutItem {
  readonly index: number;
  readonly value: string;
  readonly total: number;
}

export const make = Effect.gen(function* () {
  const store = yield* makeWorkflowRunStore;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const commandCenter = yield* CommandCenterService.CommandCenterService;
  const artifacts = yield* ArtifactsService.ArtifactsService;
  const workflows = yield* WorkflowStore.WorkflowStore;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* WorkflowThreads;
  // One waiter per running thread step, interrupted when the step stops.
  const waiters = yield* FiberMap.make<string>();
  // Changes run here, not on the caller's request: a client that hangs up mid-launch must not
  // leave a step running with no thread or waiter.
  const changesInFlight = yield* FiberSet.make();
  const detached = <A, E>(effect: Effect.Effect<A, E>) =>
    FiberSet.run(changesInFlight, effect).pipe(Effect.flatMap(Fiber.join));
  // ponytail: one lock for every run; per-run locks if many runs ever queue behind launches.
  const lock = yield* Semaphore.make(1);
  const withLock = lock.withPermits(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (message: string) => Effect.fail(new CommandCenterError({ message }));
  const settings = serverSettings.getSettings.pipe(
    Effect.mapError(failWith("Could not read the server settings.")),
  );
  const requireEnabled = settings.pipe(
    Effect.flatMap((value) =>
      value.commandCenter.enabled
        ? Effect.void
        : fail("Command Center is turned off on this server (commandCenter.enabled)."),
    ),
  );
  // Memory and artifacts are written only where the user keeps Command Center.
  const isHome = commandCenter.checkAgentAccess().pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

  const decodeModeLimit = (text: unknown): DispatchModes | null =>
    Option.getOrNull(decodeModeLimitJson(text));

  const openPass = (runId: CommandCenterWorkflowRunId) =>
    Effect.gen(function* () {
      const detail = yield* store.get({ runId });
      const [limitRow] = yield* sql<{ readonly mode_limit: unknown }>`
        SELECT mode_limit FROM cc_workflow_runs WHERE id = ${runId}
      `.pipe(Effect.mapError(failWith("Could not read the workflow run.")));
      const itemRows = yield* sql<{ readonly id: string; readonly items: string }>`
        SELECT id, items FROM cc_workflow_steps WHERE run_id = ${runId} AND items IS NOT NULL
      `.pipe(Effect.mapError(failWith("Could not read the workflow run.")));
      const items = new Map<string, ReadonlyArray<string>>();
      for (const row of itemRows) {
        // A corrupt list falls back to the step's output.
        const parsed = decodeItems(row.items);
        if (Option.isSome(parsed)) items.set(row.id, parsed.value);
      }
      return {
        run: detail.run,
        workflow: detail.workflow,
        graph: buildGraph(detail.workflow),
        latest: latestSteps(detail.steps),
        modeLimit: decodeModeLimit(limitRow?.mode_limit),
        items,
      } satisfies Pass;
    });

  /** Whether a parallel node runs over this node's output (not an input of the same name). */
  const isFannedOver = (pass: Pass, nodeId: string) =>
    pass.workflow.nodes.some(
      (node) =>
        node.kind === "parallel" &&
        node.over === nodeId &&
        !pass.workflow.inputs.some((input) => input.name === nodeId),
    );

  /** Keeps a finished step's full item list for the parallel node that runs over it. */
  const saveItems = (pass: Pass, step: Step, items: ReadonlyArray<string>) =>
    sql`UPDATE cc_workflow_steps SET items = ${encodeItems(items)} WHERE id = ${step.id}`.pipe(
      Effect.mapError(failWith("Could not save the workflow step.")),
      Effect.tap(() => Effect.sync(() => pass.items.set(step.id, items))),
    );

  const save = (pass: Pass, step: Step) =>
    store
      .saveStep(pass.run.projectId, step)
      .pipe(
        Effect.tap(() => Effect.sync(() => pass.latest.set(stepKey(step.nodeId, step.item), step))),
      );

  const saveRun = (pass: Pass, patch: Partial<Run>) =>
    Effect.gen(function* () {
      pass.run = yield* store.saveRun(
        { ...pass.run, ...patch, updatedAt: yield* nowIso },
        pass.workflow,
      );
      return pass.run;
    });

  /** A new pending attempt for a node (and fan-out item). */
  const newStep = (pass: Pass, nodeId: CommandCenterWorkflowNodeId, item: number | null) =>
    Effect.map(nowIso, (now): Step => {
      const attempt = (pass.latest.get(stepKey(nodeId, item))?.attempt ?? 0) + 1;
      return {
        id: `${pass.run.id}:${nodeId}:${item ?? "-"}:${attempt}`,
        runId: pass.run.id,
        nodeId,
        item,
        attempt,
        threadId: null,
        status: "pending",
        output: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      };
    });

  const finish = (pass: Pass, step: Step, patch: Pick<Step, "status" | "output" | "error">) =>
    Effect.flatMap(nowIso, (now) =>
      save(pass, { ...step, ...patch, finishedAt: now, updatedAt: now }),
    );

  /**
   * The items a parallel node runs over: an input, or the full list the node it names finished
   * with (its clipped output only for steps saved before lists were kept).
   */
  const fanOutItems = (pass: Pass, node: CommandCenterWorkflowParallelNode) => {
    if (pass.workflow.inputs.some((input) => input.name === node.over)) {
      return parseItems(pass.run.inputs[node.over] ?? "");
    }
    const source = pass.latest.get(stepKey(node.over, null));
    if (source === undefined) return [];
    return pass.items.get(source.id) ?? parseItems(source.output ?? "");
  };

  const childItem = (pass: Pass, step: Step): FanOutItem | null => {
    const parent = pass.graph.parentOf.get(step.nodeId);
    if (parent === undefined || step.item === null) return null;
    const items = fanOutItems(pass, parent);
    return { index: step.item, value: items[step.item] ?? "", total: items.length };
  };

  /** Model, modes and role for a step, within the run's mode limit. */
  const stepSettings = Effect.fn("WorkflowRunner.stepSettings")(function* (
    pass: Pass,
    node: ThreadNode,
  ) {
    const chosen = yield* profileSettings(node);
    if (pass.modeLimit === null) return chosen;
    return { ...chosen, ...clampDispatchModes(pass.modeLimit, chosen) };
  });

  /** Model, modes and role for a step: the agent's profile, or the server defaults. */
  const profileSettings = Effect.fn("WorkflowRunner.profileSettings")(function* (node: ThreadNode) {
    const current = yield* settings;
    const fallback = {
      modelSelection: current.defaultModelSelection ?? current.textGenerationModelSelection,
      runtimeMode: current.defaultRuntimeMode,
      interactionMode: "default" as const,
      rolePrompt: "",
    };
    // Skills and checks are small jobs for the cheap model.
    if (node.kind !== "agent") {
      return { ...fallback, modelSelection: current.textGenerationModelSelection };
    }
    if (node.profile === undefined) return fallback;
    if (typeof node.profile !== "string") return { ...fallback, modelSelection: node.profile };
    // By id, or by name for hand-written files.
    const [row] = yield* sql<Row>`
      SELECT * FROM cc_agent_profiles
      WHERE (id = ${node.profile} OR lower(name) = lower(${node.profile})) AND archived_at IS NULL
      ORDER BY id = ${node.profile} DESC
      LIMIT 1
    `.pipe(Effect.mapError(failWith("Could not read the agent profile.")));
    if (row === undefined) return yield* fail(`No agent profile "${node.profile}".`);
    const profile = yield* decodeRows("Could not read the agent profile.", decodeAgentProfile, () =>
      fromRow(row),
    );
    return {
      modelSelection: profile.modelSelection,
      runtimeMode: profile.runtimeMode,
      interactionMode: profile.interactionMode,
      rolePrompt: profile.rolePrompt,
    };
  });

  const loadSnippets = Effect.fn("WorkflowRunner.loadSnippets")(function* (
    projectId: ProjectId,
    text: string,
  ) {
    const snippets = new Map<string, string>();
    for (const reference of snippetReferences(text)) {
      const name = decodeSnippetName(reference);
      if (Option.isNone(name))
        return yield* fail(`"{{snippet:${reference}}}" is not a snippet name.`);
      snippets.set(
        reference,
        (yield* workflows.getSnippet({ projectId, name: name.value })).content,
      );
    }
    return snippets;
  });

  /**
   * The short results of the steps a node follows; never their transcripts. An answer or a passed
   * check says little alone, so the results before an ask or gate come along too (oldest first),
   * up to `HANDOFF_LIMIT`.
   */
  const handoffContext = (pass: Pass, node: Node) => {
    const blocks: string[] = [];
    const seen = new Set<string>();
    let size = 0;
    const visit = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const source = pass.graph.nodes.get(id);
      if (source?.kind === "ask" || source?.kind === "gate") {
        for (const before of pass.graph.incoming.get(id) ?? []) visit(before);
      }
      const output = pass.latest.get(stepKey(id, null))?.output;
      if (!output || size + output.length > HANDOFF_LIMIT) return;
      size += output.length;
      blocks.push(`## ${nodeTitle(source, id)}\n${output}`);
    };
    for (const id of pass.graph.incoming.get(node.id) ?? []) visit(id);
    return blocks.length === 0
      ? ""
      : `Results from the steps before this one:\n\n${blocks.join("\n\n")}`;
  };

  const stepPrompt = Effect.fn("WorkflowRunner.stepPrompt")(function* (
    pass: Pass,
    node: ThreadNode,
    item: FanOutItem | null,
    rolePrompt: string,
  ) {
    const task =
      node.kind === "agent"
        ? node.prompt
        : node.kind === "skill"
          ? `Use the "${node.skill}" skill.${node.args ? `\n\n${node.args}` : ""}`
          : gateInstruction(node.check === "typecheck" ? "typecheck" : "tests");
    const snippets = yield* loadSnippets(pass.run.projectId, task);
    const body = fillTemplate(task, { inputs: pass.run.inputs, snippets, item: item?.value });
    return [
      rolePrompt,
      `You are running the step "${nodeTitle(node)}" of the workflow "${pass.workflow.title}".`,
      body,
      item !== null && !task.includes("{{item}}")
        ? `Item ${item.index + 1} of ${item.total}: ${item.value}`
        : "",
      node.kind === "agent" && node.skills.length > 0
        ? `Use these skills: ${node.skills.join(", ")}.`
        : "",
      handoffContext(pass, pass.graph.parentOf.get(node.id) ?? node),
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");
  });

  /**
   * `wf/<slug>-<node>[-<item>][-a<attempt>]-<run>`. Only the slug and node part is cut, so items
   * and retries of one node never share a branch (or a worktree path).
   */
  const branchName = (pass: Pass, step: Step) =>
    `wf/${[
      sanitizeBranchFragment(`${pass.run.slug} ${step.nodeId}`)
        .slice(0, 40)
        .replace(/[./_-]+$/, ""),
      ...(step.item === null ? [] : [`${step.item + 1}`]),
      ...(step.attempt > 1 ? [`a${step.attempt}`] : []),
      pass.run.id.replaceAll("-", "").slice(0, 8),
    ].join("-")}`;

  /**
   * Worktree steps share the run's worktree once an earlier worktree step finished in one;
   * until then (or alongside a running one) a step gets its own. Fan-out children always do,
   * since they run at once. Checks run where the work is.
   */
  const stepWorkspace = Effect.fn("WorkflowRunner.stepWorkspace")(function* (
    pass: Pass,
    node: ThreadNode,
    step: Step,
  ) {
    const worktree = node.kind === "agent" && node.worktree;
    if (worktree && step.item !== null) {
      return {
        type: "worktree",
        baseRef: "HEAD",
        branch: branchName(pass, step),
      } satisfies ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
    }
    if (!worktree && node.kind !== "gate") return { type: "root" } as const;
    const owners = [...pass.latest.values()]
      .filter((step) => {
        const owner = pass.graph.nodes.get(step.nodeId);
        return (
          step.item === null &&
          step.status === "succeeded" &&
          step.threadId !== null &&
          owner?.kind === "agent" &&
          owner.worktree
        );
      })
      .toSorted((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""));
    for (const owner of owners) {
      if (owner.threadId === null) continue;
      const existing = yield* threads.worktree(owner.threadId);
      if (existing !== null) {
        return {
          type: "existing_worktree",
          worktreePath: existing.path,
          ...(existing.branch === null ? {} : { branch: existing.branch }),
        } satisfies ThreadLaunchService.ThreadLaunchWorkspaceStrategy;
      }
    }
    return worktree
      ? ({
          type: "worktree",
          baseRef: "HEAD",
          branch: branchName(pass, step),
        } satisfies ThreadLaunchService.ThreadLaunchWorkspaceStrategy)
      : ({ type: "root" } as const);
  });

  /** Follows a running step's thread; its end comes back through `complete`. */
  const watch = (runId: CommandCenterWorkflowRunId, step: Step): Effect.Effect<void> =>
    step.threadId === null
      ? Effect.void
      : FiberMap.run(
          waiters,
          step.id,
          threads.awaitSettled(step.threadId).pipe(
            Effect.exit,
            Effect.flatMap((exit) => complete(runId, step.id, exit)),
          ),
          { onlyIfMissing: true },
        ).pipe(Effect.asVoid);

  const launchStep = Effect.fn("WorkflowRunner.launchStep")(function* (
    pass: Pass,
    node: ThreadNode,
    step: Step,
    item: FanOutItem | null,
  ) {
    const running = yield* save(pass, {
      ...step,
      status: "running",
      startedAt: step.startedAt ?? (yield* nowIso),
    });
    const launched = yield* Effect.result(
      Effect.gen(function* () {
        const { rolePrompt, ...model } = yield* stepSettings(pass, node);
        return yield* threads.launch({
          // The step id, so a relaunch after a restart replays the first launch.
          key: step.id,
          projectId: pass.run.projectId,
          title: clip(
            `${pass.workflow.title}: ${nodeTitle(node)}${item === null ? "" : ` ${item.index + 1}`}`,
            80,
          ),
          prompt: yield* stepPrompt(pass, node, item, rolePrompt),
          ...model,
          workspace: yield* stepWorkspace(pass, node, step),
        });
      }),
    );
    if (Result.isFailure(launched)) {
      return yield* finish(pass, running, {
        status: "failed",
        output: null,
        error: clip(launched.failure.message),
      });
    }
    const withThread = yield* save(pass, { ...running, threadId: launched.success });
    yield* watch(pass.run.id, withThread);
    return withThread;
  });

  const startStep = (pass: Pass, node: Node, step: Step, item: FanOutItem | null) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const begun: Step = {
        ...step,
        threadId: null,
        output: null,
        error: null,
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      };
      switch (node.kind) {
        case "ask":
          return yield* save(pass, { ...begun, status: "waiting" });
        case "gate":
          return node.check === "manual"
            ? yield* save(pass, { ...begun, status: "waiting" })
            : yield* launchStep(pass, node, begun, null);
        case "agent":
        case "skill":
          return yield* launchStep(pass, node, begun, item);
        case "parallel":
          yield* save(pass, { ...begun, status: "running" });
          return yield* fanOut(pass, node);
      }
    });

  /** Starts children up to the concurrency bound; settles the parallel step once all ended. */
  const fanOut = (
    pass: Pass,
    node: CommandCenterWorkflowParallelNode,
  ): Effect.Effect<Step, CommandCenterError> =>
    Effect.gen(function* () {
      const parent = pass.latest.get(stepKey(node.id, null));
      const body = pass.graph.nodes.get(node.node);
      if (parent === undefined) return yield* fail(`The parallel step "${node.id}" has no run.`);
      if (body === undefined || (body.kind !== "agent" && body.kind !== "skill")) {
        return yield* finish(pass, parent, {
          status: "failed",
          output: null,
          error: `"${node.node}" is not an agent or skill node.`,
        });
      }
      const items = fanOutItems(pass, node);
      const child = (index: number) => pass.latest.get(stepKey(body.id, index));
      let running = items.filter((_, index) => child(index)?.status === "running").length;
      for (let index = 0; index < items.length && running < PARALLEL_CONCURRENCY; index++) {
        const current = child(index);
        if (current !== undefined && current.status !== "pending") continue;
        const started = yield* startStep(
          pass,
          body,
          current ?? (yield* newStep(pass, body.id, index)),
          { index, value: items[index] ?? "", total: items.length },
        );
        if (started.status === "running") running++;
      }
      const children = items.map((_, index) => child(index));
      if (children.some((step) => step === undefined || OPEN_STEP.has(step.status))) return parent;
      const missed = children.filter((step) => step?.status !== "succeeded").length;
      if (missed === 0 && isFannedOver(pass, node.id)) {
        yield* saveItems(
          pass,
          parent,
          children.map((step) => step?.output ?? ""),
        );
      }
      return yield* finish(
        pass,
        parent,
        missed === 0
          ? {
              status: "succeeded",
              output:
                clip(
                  children.map((step, index) => `${index + 1}. ${step?.output ?? ""}`).join("\n"),
                ) || "No items.",
              error: null,
            }
          : {
              status: "failed",
              output: null,
              error: `${missed} of ${items.length} items did not finish.`,
            },
      );
    });

  const isReady = (pass: Pass, node: Node) =>
    (pass.graph.deps.get(node.id) ?? []).every(
      (id) => pass.latest.get(stepKey(id, null))?.status === "succeeded",
    );

  /** Run status from its steps once nothing more can start. */
  const settleRun = (pass: Pass) =>
    Effect.gen(function* () {
      const steps = [...pass.latest.values()];
      const title = (step: Step) => nodeTitle(pass.graph.nodes.get(step.nodeId), step.nodeId);
      let status: CommandCenterWorkflowRunStatus;
      let error: string | null = null;
      if (steps.some((step) => step.status === "running" || step.status === "pending")) {
        status = "running";
      } else if (steps.some((step) => step.status === "waiting")) {
        status = "waiting";
      } else if (
        pass.graph.order.every(
          (node) => pass.latest.get(stepKey(node.id, null))?.status === "succeeded",
        )
      ) {
        status = "succeeded";
      } else {
        const failed = steps.find((step) => step.status === "failed");
        const stopped = steps.find((step) => step.status === "stopped");
        status = failed === undefined && stopped !== undefined ? "stopped" : "failed";
        error =
          failed !== undefined
            ? clip(`${title(failed)} failed: ${failed.error ?? "no reason given."}`)
            : stopped !== undefined
              ? clip(`Stopped at ${title(stopped)}${stopped.output ? `: ${stopped.output}` : "."}`)
              : "No step can run; check the graph.";
      }
      const finishedAt = FINISHED_RUN.has(status) ? (pass.run.finishedAt ?? (yield* nowIso)) : null;
      if (
        status === pass.run.status &&
        error === pass.run.error &&
        finishedAt === pass.run.finishedAt
      ) {
        return pass.run;
      }
      return yield* saveRun(pass, { status, error, finishedAt });
    });

  /** Starts every node whose inputs are ready, then works out the run's status. */
  const advance = (pass: Pass) =>
    Effect.gen(function* () {
      if (FINISHED_RUN.has(pass.run.status)) return pass.run;
      for (const node of pass.graph.order) {
        const current = pass.latest.get(stepKey(node.id, null));
        if (current === undefined) {
          if (isReady(pass, node))
            yield* startStep(pass, node, yield* newStep(pass, node.id, null), null);
        } else if (current.status === "pending") {
          yield* startStep(pass, node, current, null);
        } else if (node.kind === "parallel" && current.status === "running") {
          yield* fanOut(pass, node);
        }
      }
      return yield* settleRun(pass);
    });

  /** What a finished thread leaves: a check's verdict, or a short handoff for the next steps. */
  const outcome = Effect.fn("WorkflowRunner.outcome")(function* (
    pass: Pass,
    node: Node,
    step: Step,
    result: WorkflowThreadResult,
  ) {
    if (!result.ok) {
      return { status: "failed", output: null, error: clip(result.text) } satisfies Pick<
        Step,
        "status" | "output" | "error"
      >;
    }
    if (node.kind === "gate") {
      return checkPassed(result.text)
        ? ({ status: "succeeded", output: "Passed.", error: null } as const)
        : ({ status: "failed", output: null, error: clipTail(result.text) } as const);
    }
    const handoff = clip(result.text);
    if (node.kind !== "agent" || node.outputs === "text" || handoff === "" || !(yield* isHome)) {
      return { status: "succeeded", output: handoff, error: null } as const;
    }
    if (node.outputs === "memory") {
      yield* commandCenter
        .upsert({
          entity: "memory",
          value: {
            projectId: pass.run.projectId,
            sectionId: null,
            threadId: step.threadId,
            kind: "handoff",
            text: handoff,
            done: false,
            source: "agent",
          },
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not save a workflow handoff", { error }),
          ),
        );
      return { status: "succeeded", output: handoff, error: null } as const;
    }
    const title = clip(`${pass.workflow.title}: ${nodeTitle(node)}`, 200);
    const saved = yield* artifacts
      .save(
        {
          title,
          kind: "markdown",
          projectId: pass.run.projectId,
          content: result.text,
          ...(step.threadId === null ? {} : { threadId: step.threadId }),
        },
        { author: "agent", label: null },
      )
      .pipe(
        Effect.asSome,
        Effect.catch((error) =>
          Effect.logWarning("Could not save a workflow artifact", { error }).pipe(
            Effect.as(Option.none()),
          ),
        ),
      );
    return {
      status: "succeeded",
      // The reference reads like the orchestrator's, so agents fetch it with artifact_get.
      output: Option.isNone(saved)
        ? handoff
        : clip(
            `Use the artifact "${title}" (id ${saved.value.artifact.id}, v${saved.value.artifact.currentVersion}); read it with artifact_get.\n\n${result.text}`,
          ),
      error: null,
    } as const;
  });

  const complete = (
    runId: CommandCenterWorkflowRunId,
    stepId: string,
    exit: Exit.Exit<WorkflowThreadResult, CommandCenterError>,
  ): Effect.Effect<void> =>
    withLock(
      Effect.gen(function* () {
        const pass = yield* openPass(runId);
        const step = [...pass.latest.values()].find((candidate) => candidate.id === stepId);
        // Stopped or retried meanwhile: this thread no longer decides anything.
        if (step === undefined || step.status !== "running") return;
        const node = pass.graph.nodes.get(step.nodeId);
        const finished = yield* finish(
          pass,
          step,
          Exit.isFailure(exit)
            ? { status: "failed", output: null, error: clip(causeMessage(exit.cause)) }
            : node === undefined
              ? { status: "failed", output: null, error: "The step's node is gone." }
              : yield* outcome(pass, node, step, exit.value),
        );
        // Parsed from the whole reply: the clipped output would drop or cut items.
        if (Exit.isSuccess(exit) && finished.status === "succeeded" && step.item === null) {
          if (isFannedOver(pass, step.nodeId)) {
            yield* saveItems(pass, finished, parseItems(exit.value.text));
          }
        }
        yield* advance(pass);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record a workflow step's end", { runId, stepId, cause }),
      ),
    );

  /** Turns a failed or stopped step into a new pending attempt (a parallel step: its children). */
  const reopen = (pass: Pass, node: Node, item: number | null) =>
    Effect.gen(function* () {
      const step = pass.latest.get(stepKey(node.id, item));
      if (step === undefined || !RETRYABLE_STEP.has(step.status)) return false;
      const now = yield* nowIso;
      const resumeParent = (parentStep: Step | undefined) =>
        parentStep !== undefined && RETRYABLE_STEP.has(parentStep.status)
          ? save(pass, {
              ...parentStep,
              status: "running",
              error: null,
              finishedAt: null,
              updatedAt: now,
            })
          : Effect.void;
      if (node.kind === "parallel") {
        yield* resumeParent(step);
        for (const child of Array.from(pass.latest.values())) {
          if (
            child.nodeId === node.node &&
            child.item !== null &&
            RETRYABLE_STEP.has(child.status)
          ) {
            yield* save(pass, yield* newStep(pass, child.nodeId, child.item));
          }
        }
      } else {
        yield* save(pass, yield* newStep(pass, node.id, item));
        const parent = pass.graph.parentOf.get(node.id);
        if (parent !== undefined) yield* resumeParent(pass.latest.get(stepKey(parent.id, null)));
      }
      return true;
    });

  const reopenRun = (pass: Pass) =>
    FINISHED_RUN.has(pass.run.status)
      ? saveRun(pass, { status: "running", error: null, finishedAt: null })
      : Effect.succeed(pass.run);

  /** The project's workflow file, or the built-in starter of that slug when it has none. */
  const loadWorkflow = Effect.fn("WorkflowRunner.loadWorkflow")(function* (
    projectId: ProjectId,
    slug: CommandCenterWorkflowSlug,
  ) {
    const starter = WORKFLOW_STARTERS.find((candidate) => candidate.slug === slug);
    const detail = yield* workflows.get({ projectId, slug }).pipe(
      Effect.catchIf(
        (error) => starter !== undefined && error.message.startsWith("No workflow named"),
        () => Effect.succeed(null),
      ),
    );
    if (detail === null && starter !== undefined) return starter;
    if (detail === null || detail.workflow === null) {
      return yield* fail(`The workflow "${slug}" cannot run: ${detail?.errors.join(" ") ?? ""}`);
    }
    return detail.workflow;
  });

  const start = Effect.fn("WorkflowRunner.start")(function* (
    input: CommandCenterWorkflowRunStartInput,
    options: WorkflowRunStartOptions = {},
  ) {
    yield* requireEnabled;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    if (input.environmentId !== undefined && input.environmentId !== environmentId) {
      return yield* fail(
        "This server only runs workflows for its own projects; start the run on the environment that has the project.",
      );
    }
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(failWith("Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* fail("That project is not on this machine; start the run where it lives.");
    }
    let workflow: CommandCenterWorkflow;
    if (input.workflow === undefined) {
      workflow = yield* loadWorkflow(input.projectId, input.slug);
    } else {
      const errors = validateCommandCenterWorkflow(input.workflow);
      if (errors.length > 0) return yield* fail(`The workflow cannot run: ${errors.join(" ")}`);
      workflow = { ...input.workflow, slug: input.slug };
    }
    if (workflow.nodes.length === 0) return yield* fail("This workflow has no steps yet.");
    const resolved = resolveInputs(workflow.inputs, input.inputs);
    if ("error" in resolved) return yield* fail(resolved.error);
    const now = yield* nowIso;
    const id = CommandCenterWorkflowRunId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.mapError(failWith("Could not start the run."))),
    );
    yield* store.saveRun(
      {
        id,
        slug: workflow.slug,
        title: workflow.title,
        projectId: input.projectId,
        environmentId,
        status: "running",
        inputs: resolved.inputs,
        error: null,
        startedAt: now,
        finishedAt: null,
        updatedAt: now,
      },
      workflow,
      options.modeLimit ?? null,
    );
    return yield* detached(withLock(Effect.flatMap(openPass(id), advance)));
  });

  const stop = Effect.fn("WorkflowRunner.stop")(function* (input: CommandCenterWorkflowRunRef) {
    return yield* detached(
      withLock(
        Effect.gen(function* () {
          const pass = yield* openPass(input.runId);
          if (FINISHED_RUN.has(pass.run.status)) return pass.run;
          for (const step of Array.from(pass.latest.values())) {
            if (!OPEN_STEP.has(step.status)) continue;
            yield* FiberMap.remove(waiters, step.id);
            yield* finish(pass, step, {
              status: "stopped",
              output: step.output,
              error: "Stopped.",
            });
            if (step.status === "running" && step.threadId !== null) {
              yield* threads
                .stop(step.threadId, step.id)
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Could not stop a workflow step's thread", { error }),
                  ),
                );
            }
          }
          return yield* saveRun(pass, {
            status: "stopped",
            error: null,
            finishedAt: yield* nowIso,
          });
        }),
      ),
    );
  });

  const retryStep = Effect.fn("WorkflowRunner.retryStep")(function* (
    input: CommandCenterWorkflowRetryStepInput,
  ) {
    yield* requireEnabled;
    return yield* detached(
      withLock(
        Effect.gen(function* () {
          const pass = yield* openPass(input.runId);
          const named = pass.graph.nodes.get(input.nodeId);
          if (named === undefined) return yield* fail(`This run has no step "${input.nodeId}".`);
          // An item of a parallel step means that child of its body.
          const node =
            named.kind === "parallel" && input.item !== undefined
              ? pass.graph.nodes.get(named.node)
              : named;
          if (node === undefined) return yield* fail(`This run has no step "${input.nodeId}".`);
          const inBody = pass.graph.parentOf.has(node.id);
          if (inBody && input.item === undefined) {
            return yield* fail(
              "Name the item to retry, or retry the parallel step for all of them.",
            );
          }
          if (!(yield* reopen(pass, node, inBody ? (input.item ?? null) : null))) {
            return yield* fail("Only a failed or stopped step can be retried.");
          }
          yield* reopenRun(pass);
          return yield* advance(pass);
        }),
      ),
    );
  });

  const resume = Effect.fn("WorkflowRunner.resume")(function* (input: CommandCenterWorkflowRunRef) {
    yield* requireEnabled;
    return yield* detached(
      withLock(
        Effect.gen(function* () {
          const pass = yield* openPass(input.runId);
          if (pass.run.status === "succeeded") return yield* fail("This run already finished.");
          const before = new Map(pass.latest);
          for (const step of before.values()) {
            // Follow a running step whose waiter was lost (Command Center was off at boot).
            if (step.status === "running" && step.threadId !== null) {
              yield* watch(pass.run.id, step);
              continue;
            }
            if (!RETRYABLE_STEP.has(step.status)) continue;
            const node = pass.graph.nodes.get(step.nodeId);
            if (node === undefined) continue;
            const parent = pass.graph.parentOf.get(node.id);
            // Children of a retried parallel step come back with it.
            const parentStep = parent && before.get(stepKey(parent.id, null));
            if (
              step.item !== null &&
              parentStep !== undefined &&
              RETRYABLE_STEP.has(parentStep.status)
            ) {
              continue;
            }
            yield* reopen(pass, node, step.item);
          }
          yield* reopenRun(pass);
          return yield* advance(pass);
        }),
      ),
    );
  });

  const answer = Effect.fn("WorkflowRunner.answer")(function* (
    input: CommandCenterWorkflowAnswerStepInput,
  ) {
    yield* requireEnabled;
    return yield* detached(
      withLock(
        Effect.gen(function* () {
          const pass = yield* openPass(input.runId);
          const node = pass.graph.nodes.get(input.nodeId);
          const step = pass.latest.get(stepKey(input.nodeId, null));
          if (node === undefined || step === undefined || step.status !== "waiting") {
            return yield* fail("That step is not waiting for an answer.");
          }
          const text = clip(input.answer ?? "");
          if (node.kind === "ask") {
            if (text === "") return yield* fail("Answer the question first.");
            const stops = node.choices?.slice(1).includes(text) === true;
            yield* finish(pass, step, {
              status: stops ? "stopped" : "succeeded",
              output: text,
              error: null,
            });
          } else if (node.kind === "gate") {
            if (input.approved === undefined) return yield* fail("Approve or reject the gate.");
            yield* finish(
              pass,
              step,
              input.approved
                ? { status: "succeeded", output: text || "Approved.", error: null }
                : {
                    status: "failed",
                    output: null,
                    error: clip(text ? `Rejected: ${text}` : "Rejected."),
                  },
            );
          } else {
            return yield* fail("That step is not waiting for an answer.");
          }
          return yield* advance(pass);
        }),
      ),
    );
  });

  // A restart cut every waiter: follow the threads of running steps again, relaunch the ones
  // that never got a thread (the same key replays a launch that did go out), then catch up.
  const recover = Effect.gen(function* () {
    if (!(yield* settings).commandCenter.enabled) return;
    const open = yield* sql<{ readonly id: string }>`
      SELECT id FROM cc_workflow_runs WHERE finished_at IS NULL
    `.pipe(Effect.mapError(failWith("Could not read the workflow runs.")));
    for (const { id } of open) {
      yield* withLock(
        Effect.gen(function* () {
          const pass = yield* openPass(CommandCenterWorkflowRunId.make(id));
          for (const step of Array.from(pass.latest.values())) {
            const node = pass.graph.nodes.get(step.nodeId);
            if (step.status !== "running" || node === undefined) continue;
            if (node.kind === "agent" || node.kind === "skill" || node.kind === "gate") {
              if (step.threadId !== null) yield* watch(pass.run.id, step);
              else yield* launchStep(pass, node, step, childItem(pass, step));
            }
          }
          yield* advance(pass);
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not resume a workflow run after restart", { runId: id, cause }),
        ),
      );
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not recover workflow runs", { cause })),
  );
  yield* forkParked(recover);
  // Turned on later: follow the runs a boot with Command Center off left alone.
  yield* forkParked(
    serverSettings.streamChanges.pipe(
      Stream.map((value) => value.commandCenter.enabled),
      Stream.changes,
      Stream.filter((enabled) => enabled),
      Stream.runForEach(() => recover),
    ),
  );

  // A scheduled task whose prompt is `/wf <slug> [name=value]... [text]` runs the workflow
  // instead of starting a thread, within the task's modes.
  const scheduledRoute = (prompt: ScheduledPrompt) =>
    Effect.gen(function* () {
      const command = parseWorkflowCommand(prompt.prompt);
      if (command === null) return false;
      const slug = decodeSlug(command.slug);
      if (Option.isNone(slug)) return yield* fail(`"/wf ${command.slug}" names no workflow.`);
      const workflow = yield* loadWorkflow(prompt.projectId, slug.value);
      const plan = planWorkflowInputs(workflow.inputs, command);
      if (plan.unknown.length > 0) {
        return yield* fail(
          `The workflow "${slug.value}" has no input ${plan.unknown.map((name) => `"${name}"`).join(", ")}.`,
        );
      }
      if (plan.leftover !== "") {
        return yield* fail(
          `Every input of "${slug.value}" already has a value: "${plan.leftover}".`,
        );
      }
      yield* start(
        { projectId: prompt.projectId, slug: slug.value, inputs: plan.inputs, workflow },
        { modeLimit: { runtimeMode: prompt.runtimeMode, interactionMode: prompt.interactionMode } },
      );
      return true;
    });
  const promptRoutes = yield* Effect.serviceOption(ScheduledTaskPromptRoutes);
  if (Option.isSome(promptRoutes)) yield* promptRoutes.value.register(scheduledRoute);

  return WorkflowRunner.of({
    start,
    stop,
    retryStep,
    resume,
    answer,
    list: store.list,
    get: store.get,
    subscribe: store.subscribe,
  });
});

export const layer = Layer.effect(WorkflowRunner, make);
