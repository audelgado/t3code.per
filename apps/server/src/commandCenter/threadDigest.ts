import {
  COMMAND_CENTER_THREAD_DIGEST_MAX_TEXT,
  type CommandCenterThreadDigest,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";

type FinishedRun = OrchestrationV2Run & { readonly status: "completed" | "failed" };

const isFinished = (run: OrchestrationV2Run): run is FinishedRun =>
  run.status === "completed" || run.status === "failed";

const endedAt = (run: OrchestrationV2Run) =>
  run.completedAt === null ? 0 : DateTime.toEpochMillis(run.completedAt);

/**
 * The thread's completed or failed run that ended last (queued runs can finish out of ordinal
 * order); a digest has nothing to show before one.
 */
export const latestFinishedRun = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs
    .filter(isFinished)
    .reduce<FinishedRun | undefined>(
      (latest, run) =>
        latest === undefined ||
        endedAt(run) > endedAt(latest) ||
        (endedAt(run) === endedAt(latest) && run.ordinal > latest.ordinal)
          ? run
          : latest,
      undefined,
    );

/** Never ends inside a surrogate pair, so a clipped emoji does not become a broken glyph. */
const cut = (text: string, end: number) => {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
};

const clip = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length <= COMMAND_CENTER_THREAD_DIGEST_MAX_TEXT
    ? trimmed
    : `${trimmed.slice(0, cut(trimmed, COMMAND_CENTER_THREAD_DIGEST_MAX_TEXT - 1)).trimEnd()}…`;
};

/** The run's final reply (or error) and the diff size of the thread's latest checkpoint. */
export const digestFromRecords = (
  threadId: ThreadId,
  run: FinishedRun,
  records: Pick<OrchestrationV2ThreadProjection, "messages" | "turnItems"> & {
    readonly checkpoints: ReadonlyArray<Pick<OrchestrationV2Checkpoint, "capturedAt" | "files">>;
  },
): CommandCenterThreadDigest => {
  const checkpoint = records.checkpoints.reduce<(typeof records.checkpoints)[number] | undefined>(
    (latest, candidate) =>
      latest === undefined ||
      DateTime.toEpochMillis(candidate.capturedAt) > DateTime.toEpochMillis(latest.capturedAt)
        ? candidate
        : latest,
    undefined,
  );
  const files = checkpoint?.files ?? [];
  return {
    threadId,
    text: clip(subagentResultForRun(records, run).text),
    runStatus: run.status,
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
    files: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
};
