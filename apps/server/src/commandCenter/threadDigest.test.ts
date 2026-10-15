import { expect, it } from "@effect/vitest";
import {
  CommandCenterThreadDigestsResult,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreThreadNotFoundError,
  type ProjectionRecords,
} from "../orchestration-v2/ProjectionStore.ts";
import { digestFromRecords, latestFinishedRun } from "./threadDigest.ts";
import * as WorkflowThreads from "./workflowThreads.ts";

const isDigestResult = Schema.is(CommandCenterThreadDigestsResult);
const threadId = ThreadId.make("digest-thread");
const time = (day: number) => DateTime.makeUnsafe(`2026-10-${day}T12:00:00.000Z`);
const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  day: number,
): OrchestrationV2Run => ({
  id: RunId.make(`run-${ordinal}`),
  threadId,
  ordinal,
  status,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
  providerThreadId: null,
  userMessageId: MessageId.make(`user-${ordinal}`),
  rootNodeId: null,
  activeAttemptId: null,
  requestedAt: time(10),
  startedAt: time(10),
  completedAt: status === "running" ? null : time(day),
  checkpointId: null,
  contextHandoffId: null,
});
const finished = { ...run(1, "completed", 11), status: "completed" as const };
const messages = [
  {
    id: MessageId.make("reply"),
    threadId,
    runId: finished.id,
    nodeId: null,
    role: "assistant" as const,
    text: "  " + "x".repeat(1500) + "  ",
    attachments: [],
    streaming: false,
    createdAt: time(11),
    updatedAt: time(11),
    createdBy: "system" as const,
    creationSource: "server" as const,
  },
];

it("selects the run that finished last, ignores active and cancelled runs, and breaks ties by ordinal", () => {
  const runs = [
    run(1, "completed", 13),
    run(2, "failed", 12),
    run(3, "running", 14),
    run(4, "cancelled", 14),
  ];
  expect(latestFinishedRun(runs)?.id).toBe(runs[0]?.id);
  expect(latestFinishedRun([finished, run(2, "failed", 11)])?.ordinal).toBe(2);
  expect(latestFinishedRun([run(3, "running", 14)])).toBeUndefined();
});

it("bounds the reply and sums only the latest checkpoint", () => {
  const digest = digestFromRecords(threadId, finished, {
    messages,
    turnItems: [],
    checkpoints: [
      {
        capturedAt: time(12),
        files: [
          { path: "a", kind: "modified", additions: 5, deletions: 2 },
          { path: "b", kind: "added", additions: 3, deletions: 1 },
        ],
      },
      {
        capturedAt: time(11),
        files: [{ path: "old", kind: "modified", additions: 100, deletions: 100 }],
      },
    ],
  });
  expect(digest.text).toHaveLength(1200);
  expect(digest).toMatchObject({ runStatus: "completed", files: 2, additions: 8, deletions: 3 });
  expect(isDigestResult({ digests: [digest] })).toBe(true);
  expect(
    digestFromRecords(threadId, finished, { messages: [], turnItems: [], checkpoints: [] }),
  ).toMatchObject({ files: 0, additions: 0, deletions: 0 });
});

const layerFor = (
  getThreadRecords: ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
) =>
  WorkflowThreads.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadRecords }),
      ),
    ),
  );

it.effect("reads a deduplicated batch narrowly, skips missing and unfinished threads", () =>
  Effect.gen(function* () {
    const reads: Array<{ id: ThreadId; fields: ReadonlyArray<string>; filter: unknown }> = [];
    const missing = ThreadId.make("missing");
    const active = ThreadId.make("active");
    const read: ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"] = (
      id,
      fields,
      filter,
    ) => {
      reads.push({ id, fields, filter });
      if (id === missing)
        return Effect.fail(
          new OrchestratorProjectionError({
            threadId: id,
            cause: new ProjectionStoreThreadNotFoundError({ threadId: id }),
          }),
        );
      // The fake repository returns only requested collections, as the real store does.
      const records = {
        runs: id === active ? [run(2, "running", 12)] : [finished],
        checkpoints: [],
        messages,
        turnItems: [],
      };
      return Effect.succeed(
        Object.fromEntries(
          fields.map((field) => [field, records[field as keyof typeof records]]),
        ) as unknown as ProjectionRecords<(typeof fields)[number]>,
      );
    };
    const service = yield* WorkflowThreads.WorkflowThreads.pipe(Effect.provide(layerFor(read)));
    const result = yield* service.readDigests([missing, active, threadId, threadId]);
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0]?.threadId).toBe(threadId);
    expect(reads).toHaveLength(4);
    expect(reads[3]).toEqual({
      id: threadId,
      fields: ["messages", "turnItems"],
      filter: {
        messageRoles: ["assistant"],
        messageRunIds: [finished.id],
        turnItemRunIds: [finished.id],
        turnItemTypes: ["assistant_message", "error"],
      },
    });
  }),
);

it.effect(
  "rejects oversized or empty batches before storage access and preserves read failures",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const read: ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"] = (
        id,
      ) => {
        reads++;
        return Effect.fail(new OrchestratorProjectionError({ threadId: id }));
      };
      const service = yield* WorkflowThreads.WorkflowThreads.pipe(Effect.provide(layerFor(read)));
      yield* service.readDigests([]).pipe(Effect.flip);
      yield* service.readDigests(Array.from({ length: 21 }, () => threadId)).pipe(Effect.flip);
      expect(reads).toBe(0);
      const failure = yield* service.readDigests([threadId]).pipe(Effect.flip);
      expect(failure._tag).toBe("CommandCenterError");
      expect(reads).toBe(1);
    }),
);

it("never clips inside a surrogate pair", () => {
  const text = "x".repeat(1198) + "😀".repeat(10);
  const digest = digestFromRecords(threadId, finished, {
    messages: [{ ...messages[0]!, text }],
    turnItems: [],
    checkpoints: [],
  });
  expect(digest.text).toBe("x".repeat(1198) + "…");
});
