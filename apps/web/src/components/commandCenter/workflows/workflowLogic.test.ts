import type {
  CommandCenterSkillName,
  CommandCenterWorkflow,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addNode,
  checkDraft,
  connectNodes,
  lastRunBySlug,
  mergeRunSteps,
  nodePositions,
  nodeRunStates,
  removeNode,
  renameNode,
  restoreNode,
  retryTarget,
  runInputs,
  uniqueSlug,
  withFullLayout,
} from "./workflowLogic";

const id = (value: string) => value as CommandCenterWorkflowNodeId;

const base = (): CommandCenterWorkflow =>
  ({
    slug: "demo",
    title: "Demo",
    description: "",
    inputs: [{ name: "topic", label: "Topic" }],
    nodes: [
      {
        id: "plan",
        kind: "agent",
        prompt: "Plan {{input:topic}}",
        skills: [],
        worktree: false,
        outputs: "text",
      },
      { id: "build", kind: "agent", prompt: "Build", skills: [], worktree: true, outputs: "text" },
      { id: "check", kind: "gate", check: "tests" },
    ],
    edges: [
      { from: "plan", to: "build" },
      { from: "build", to: "check" },
    ],
    layout: { plan: { x: 10, y: 20 } },
  }) as unknown as CommandCenterWorkflow;

const step = (patch: { readonly [K in keyof CommandCenterWorkflowStep]?: unknown }) =>
  ({
    id: "s",
    runId: "r1",
    nodeId: "plan",
    item: null,
    attempt: 1,
    threadId: null,
    status: "pending",
    output: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  }) as CommandCenterWorkflowStep;

describe("layout", () => {
  it("keeps saved spots and places the rest in columns by depth", () => {
    const positions = nodePositions(base());
    expect(positions.get("plan")).toEqual({ x: 10, y: 20 });
    const build = positions.get("build");
    const check = positions.get("check");
    expect(build && check && check.x > build.x).toBe(true);
    expect(Object.keys(withFullLayout(base()).layout).toSorted()).toEqual([
      "build",
      "check",
      "plan",
    ]);
  });
});

describe("edits", () => {
  it("adds nodes with unique ids and removes them with their edges", () => {
    const first = addNode(base(), "agent", { x: 0, y: 0 }, null);
    const second = addNode(first.workflow, "agent", { x: 0, y: 0 }, null);
    expect([first.id, second.id]).toEqual(["agent-1", "agent-2"]);
    const removed = removeNode(base(), "build");
    expect(removed.edges).toEqual([]);
    expect(removed.nodes.map((node) => node.id)).toEqual(["plan", "check"]);
  });

  it("adds a skill node only with a skill, and a parallel node over a free body", () => {
    const skill = addNode(base(), "skill", { x: 0, y: 0 }, "lint" as CommandCenterSkillName);
    expect(skill.workflow.nodes.at(-1)).toMatchObject({ kind: "skill", skill: "lint" });
    const withFree = addNode(base(), "agent", { x: 0, y: 0 }, null).workflow;
    const parallel = addNode(withFree, "parallel", { x: 0, y: 0 }, null);
    expect(parallel.workflow.nodes.at(-1)).toMatchObject({ over: "topic", node: "agent-1" });
  });

  it("renames a node in edges, layout and parallel references", () => {
    const withParallel: CommandCenterWorkflow = {
      ...base(),
      nodes: [
        ...base().nodes,
        { id: id("fan"), kind: "parallel", over: "plan", node: id("worker") },
        {
          id: id("worker"),
          kind: "agent",
          prompt: "",
          skills: [],
          worktree: false,
          outputs: "text",
        },
      ],
    };
    const result = renameNode(withParallel, "plan", "design");
    if (!("workflow" in result)) throw new Error(result.error);
    expect(result.workflow.edges[0]).toEqual({ from: "design", to: "build" });
    expect(result.workflow.layout.design).toEqual({ x: 10, y: 20 });
    expect(result.workflow.nodes.find((node) => node.id === "fan")).toMatchObject({
      over: "design",
    });
    expect(renameNode(base(), "plan", "build")).toEqual({ error: '"build" is taken.' });
    expect("error" in renameNode(base(), "plan", "bad id")).toBe(true);
  });

  it("undoes one deletion after later edits, keeping edges whose ends exist", () => {
    const before = base();
    const later = removeNode(removeNode(before, "build"), "check");
    const restored = restoreNode(later, before, "build");
    expect(restored.nodes.map((node) => node.id)).toEqual(["plan", "build"]);
    expect(restored.edges).toEqual([{ from: "plan", to: "build" }]);
    expect(restoreNode(restored, before, "build")).toBe(restored);
  });

  it("refuses loops, repeats and edges on a parallel body", () => {
    expect(connectNodes(base(), id("check"), id("plan"))).toEqual({
      error: "That connection would make a loop.",
    });
    expect("error" in connectNodes(base(), id("plan"), id("build"))).toBe(true);
    const ok = connectNodes(base(), id("plan"), id("check"));
    expect("workflow" in ok && ok.workflow.edges).toHaveLength(3);
    const fanned: CommandCenterWorkflow = {
      ...base(),
      nodes: [
        ...base().nodes,
        { id: id("fan"), kind: "parallel", over: "topic", node: id("check") },
      ],
    };
    expect(connectNodes(fanned, id("plan"), id("check"))).toEqual({
      error: '"check" runs inside "fan"; connect "fan" instead.',
    });
  });
});

describe("checkDraft", () => {
  it("attaches errors to the nodes they name", () => {
    const draft: CommandCenterWorkflow = {
      ...base(),
      nodes: [
        ...base().nodes,
        { id: id("q"), kind: "ask", question: "" },
        {
          id: id("x"),
          kind: "agent",
          prompt: "{{input:nope}}",
          skills: [],
          worktree: false,
          outputs: "text",
        },
      ],
    };
    const check = checkDraft(draft);
    expect(check.workflow).toBeNull();
    expect(check.byNode.get("q")?.length).toBe(1);
    expect(checkDraft(base()).workflow?.layout.check).toBeDefined();
  });
});

describe("library", () => {
  it("makes unique slugs and finds the newest run per workflow", () => {
    expect(uniqueSlug("Release Notes!", new Set(["release-notes"]))).toBe("release-notes-2");
    const runs = [
      { id: "b", slug: "demo" },
      { id: "a", slug: "demo" },
    ] as never;
    expect(lastRunBySlug(runs).get("demo")?.id).toBe("b");
  });

  it("lists required inputs left blank", () => {
    const declared = [
      { name: "a", label: "A" },
      { name: "b", label: "B", default: "x" },
    ];
    expect(runInputs(declared, { a: " " })).toEqual({ inputs: {}, missing: ["A"] });
    expect(runInputs(declared, { a: "1" })).toEqual({ inputs: { a: "1" }, missing: [] });
  });
});

describe("runs", () => {
  it("uses each item's newest attempt and the worst item for the node", () => {
    const states = nodeRunStates([
      step({ id: "1", nodeId: "plan", status: "failed" }),
      step({ id: "2", nodeId: "plan", attempt: 2, status: "succeeded" }),
      step({ id: "3", nodeId: "worker", item: 0, status: "succeeded" }),
      step({ id: "4", nodeId: "worker", item: 1, status: "failed" }),
    ]);
    expect(states.get("plan")?.status).toBe("succeeded");
    expect(states.get("worker")?.status).toBe("failed");
    expect(states.get("worker")?.steps).toHaveLength(2);
  });

  it("merges live steps over the detail by updatedAt", () => {
    const detail = [step({ id: "1", status: "running" })];
    expect(mergeRunSteps(detail, [], "r1")).toBe(detail);
    const merged = mergeRunSteps(
      detail,
      [
        step({ id: "1", status: "succeeded", updatedAt: "2026-01-02T00:00:00.000Z" }),
        step({ id: "9", runId: "other" }),
      ],
      "r1",
    );
    expect(merged).toEqual([
      step({ id: "1", status: "succeeded", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ]);
  });

  it("retries a parallel item through its parallel node", () => {
    const workflow: CommandCenterWorkflow = {
      ...base(),
      nodes: [
        ...base().nodes,
        { id: id("fan"), kind: "parallel", over: "topic", node: id("plan") },
      ],
    };
    expect(retryTarget(workflow, step({ nodeId: id("plan"), item: 2 }))).toEqual({
      nodeId: "fan",
      item: 2,
    });
    expect(retryTarget(base(), step({ nodeId: id("build") }))).toEqual({ nodeId: "build" });
  });
});
