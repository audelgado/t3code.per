import {
  COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT,
  type CommandCenterWorkflowRunsState,
  type CommandCenterWorkflowRunStreamEvent,
} from "@t3tools/contracts";

import { upsertRow } from "./commandCenter.ts";

/**
 * Folds one `subscribeWorkflowRuns` event. Changes before the first snapshot are dropped (the
 * snapshot includes them); a new run goes first, and the oldest beyond the snapshot size leaves
 * with its steps so a long-lived view stays small. Hermes-safe (no ES2023 array methods).
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
  const runs = [event.run, ...current.runs];
  if (runs.length <= COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT) return { ...current, runs };
  const kept = runs.slice(0, COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT);
  const ids = new Set(kept.map((run) => run.id));
  return { runs: kept, steps: current.steps.filter((step) => ids.has(step.runId)) };
}
