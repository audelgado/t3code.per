import {
  COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowSlug,
  EnvironmentId,
  ProjectId,
  type CommandCenterWorkflowRun,
  type CommandCenterWorkflowStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applyWorkflowRunEvent } from "./commandCenterWorkflows.ts";

const at = "2026-10-13T00:00:00.000Z";
const later = "2026-10-14T00:00:00.000Z";
const run = (id: string, status: CommandCenterWorkflowRun["status"] = "running", startedAt = at) =>
  ({
    id: CommandCenterWorkflowRunId.make(id),
    slug: CommandCenterWorkflowSlug.make("feature"),
    title: "Feature",
    projectId: ProjectId.make("project"),
    environmentId: EnvironmentId.make("environment"),
    status,
    inputs: {},
    error: null,
    startedAt,
    finishedAt: null,
    updatedAt: at,
  }) satisfies CommandCenterWorkflowRun;
const step = (runId: string, status: CommandCenterWorkflowStep["status"]) =>
  ({
    id: `${runId}:plan`,
    runId: CommandCenterWorkflowRunId.make(runId),
    nodeId: CommandCenterWorkflowNodeId.make("plan"),
    item: null,
    attempt: 1,
    threadId: null,
    status,
    output: null,
    error: null,
    startedAt: at,
    finishedAt: null,
    updatedAt: at,
  }) satisfies CommandCenterWorkflowStep;

describe("applyWorkflowRunEvent", () => {
  it("ignores changes before the snapshot, then upserts runs and steps", () => {
    expect(applyWorkflowRunEvent(null, { type: "run", run: run("a") })).toBeNull();
    let state = applyWorkflowRunEvent(null, { type: "snapshot", runs: [run("a")], steps: [] });
    state = applyWorkflowRunEvent(state, { type: "step", step: step("a", "running") });
    state = applyWorkflowRunEvent(state, { type: "step", step: step("a", "succeeded") });
    state = applyWorkflowRunEvent(state, { type: "run", run: run("a", "succeeded") });
    state = applyWorkflowRunEvent(state, { type: "run", run: run("b") });
    expect(state?.runs.map((entry) => [entry.id, entry.status])).toEqual([
      ["b", "running"],
      ["a", "succeeded"],
    ]);
    expect(state?.steps.map((entry) => entry.status)).toEqual(["succeeded"]);
  });

  it("drops the oldest run and its steps past the snapshot size", () => {
    const runs = Array.from({ length: COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT }, (_, index) =>
      run(`r${index}`),
    );
    const oldest = runs[runs.length - 1]!.id;
    const state = applyWorkflowRunEvent(
      { runs, steps: [step(oldest, "running")] },
      { type: "run", run: run("new", "running", later) },
    );
    expect(state?.runs).toHaveLength(COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT);
    expect(state?.runs[0]?.id).toBe("new");
    expect(state?.steps).toEqual([]);
    // A step for a run no longer shown is not kept either.
    expect(applyWorkflowRunEvent(state, { type: "step", step: step(oldest, "failed") })).toBe(
      state,
    );
  });

  it("keeps the feed the newest runs: an older run outside a full feed is dropped", () => {
    const runs = Array.from({ length: COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT }, (_, index) =>
      run(`r${index}`, "running", later),
    );
    const full = { runs, steps: [] };
    // Answered from the CLI: a run far older than the feed changes. The window keeps its tail.
    expect(applyWorkflowRunEvent(full, { type: "run", run: run("old", "waiting") })).toBe(full);
    // Below the cap, a run joins in server order rather than on top.
    const partial = applyWorkflowRunEvent(
      { runs: [run("b", "running", later)], steps: [] },
      { type: "run", run: run("a") },
    );
    expect(partial?.runs.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});
