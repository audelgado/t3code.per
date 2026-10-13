import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowInput,
  CommandCenterWorkflowStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeRunSteps, workflowStartInputs, workflowStepRows } from "./workflowPresentation";

const step = (fields: Partial<CommandCenterWorkflowStep>) =>
  ({
    id: `${fields.nodeId}:${fields.item ?? "-"}:${fields.attempt ?? 1}`,
    runId: "r1",
    item: null,
    attempt: 1,
    threadId: null,
    status: "pending",
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    ...fields,
  }) as CommandCenterWorkflowStep;

const workflow = {
  slug: "feature",
  title: "Feature",
  nodes: [
    { id: "plan", kind: "agent", prompt: "Plan" },
    { id: "ok", kind: "ask", question: "Go?", choices: ["Yes", "No"] },
    { id: "fan", kind: "parallel", title: "Build all", over: "plan", node: "build" },
    { id: "build", kind: "agent", title: "Build", prompt: "Build {{item}}" },
    { id: "check", kind: "gate", check: "manual" },
  ],
} as unknown as CommandCenterWorkflow;

describe("workflowStepRows", () => {
  it("shows each node's latest attempt, parallel items under their node, and what can retry", () => {
    const rows = workflowStepRows(workflow, [
      step({ nodeId: "plan" as never, status: "failed" }),
      step({ nodeId: "plan" as never, attempt: 2, status: "succeeded" }),
      step({ nodeId: "ok" as never, status: "waiting" }),
      step({ nodeId: "fan" as never, status: "running" }),
      step({ nodeId: "build" as never, item: 1, status: "stopped" }),
      step({ nodeId: "build" as never, item: 0, status: "succeeded" }),
    ]);
    expect(rows.map((row) => [row.title, row.depth, row.step?.status ?? null])).toEqual([
      ["plan", 0, "succeeded"],
      ["ok", 0, "waiting"],
      ["Build all", 0, "running"],
      ["Build #1", 1, "succeeded"],
      ["Build #2", 1, "stopped"],
      ["check", 0, null],
    ]);
    expect(rows[1]?.waiting).toEqual({ kind: "ask", question: "Go?", choices: ["Yes", "No"] });
    expect(rows.flatMap((row) => (row.retry ? [row.retry] : []))).toEqual([
      { runId: "r1", nodeId: "build", item: 1 },
    ]);
  });
});

describe("mergeRunSteps", () => {
  it("keeps the newer copy of each step of the run", () => {
    const old = step({ nodeId: "plan" as never, status: "running" });
    const fresh = { ...old, status: "succeeded", updatedAt: "2026-10-13T10:05:00.000Z" } as const;
    const other = step({ nodeId: "plan" as never, runId: "r2" as never });
    expect(mergeRunSteps("r1", [fresh], [old, other])).toEqual([fresh]);
    expect(mergeRunSteps("r1", [old], [fresh])).toEqual([fresh]);
  });
});

describe("workflowStartInputs", () => {
  const inputs = [
    { name: "bug", label: "Bug" },
    { name: "branch", label: "Branch", default: "main" },
  ] as unknown as ReadonlyArray<CommandCenterWorkflowInput>;

  it("leaves blanks to the server default and names required inputs that are empty", () => {
    expect(workflowStartInputs(inputs, { bug: "  crash  ", branch: " " })).toEqual({
      inputs: { bug: "crash" },
      missing: [],
    });
    expect(workflowStartInputs(inputs, {}).missing).toEqual(["Bug"]);
  });
});
