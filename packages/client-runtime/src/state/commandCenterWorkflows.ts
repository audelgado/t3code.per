import {
  COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT,
  type CommandCenterWorkflowRun,
  type CommandCenterWorkflowRunsState,
  type CommandCenterWorkflowRunStreamEvent,
} from "@t3tools/contracts";

import { upsertRow } from "./commandCenter.ts";

/** Server order (`listWorkflowRuns`): newest start first, id breaking ties. */
const newerFirst = (left: CommandCenterWorkflowRun, right: CommandCenterWorkflowRun) =>
  right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id);

/**
 * Folds one `subscribeWorkflowRuns` event. Changes before the first snapshot are dropped (the
 * snapshot includes them). A run not yet shown takes its place in server order and the oldest
 * beyond the snapshot size leaves with its steps, so the feed stays the newest runs with no gap
 * (an older page continues from its last run) and a long-lived view stays small. A change to a
 * run older than a full feed is dropped. Hermes-safe (no ES2023 array methods).
 */
export function applyWorkflowRunEvent(
  current: CommandCenterWorkflowRunsState | null,
  event: CommandCenterWorkflowRunStreamEvent,
): CommandCenterWorkflowRunsState | null {
  if (event.type === "snapshot") return { runs: event.runs, steps: event.steps };
  if (current === null) return null;
  if (event.type === "step") {
    if (!current.runs.some((run) => run.id === event.step.runId)) return current;
    return { ...current, steps: upsertRow(current.steps, event.step) };
  }
  if (current.runs.some((run) => run.id === event.run.id)) {
    return { ...current, runs: upsertRow(current.runs, event.run) };
  }
  const at = current.runs.findIndex((run) => newerFirst(event.run, run) < 0);
  if (at === -1 && current.runs.length >= COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT)
    return current;
  const runs = current.runs.slice();
  runs.splice(at === -1 ? runs.length : at, 0, event.run);
  if (runs.length <= COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT) return { ...current, runs };
  const kept = runs.slice(0, COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT);
  const ids = new Set(kept.map((run) => run.id));
  return { runs: kept, steps: current.steps.filter((step) => ids.has(step.runId)) };
}
