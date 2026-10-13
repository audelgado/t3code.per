import { describe, expect, it } from "@effect/vitest";

import {
  parseCommandCenterWorkflow,
  parseWorkflowCommand,
  planWorkflowInputs,
} from "./commandCenterWorkflows.ts";

const workflow = (overrides: Record<string, unknown> = {}) => ({
  slug: "feature",
  title: "Feature",
  inputs: [{ name: "feature", label: "Feature" }],
  nodes: [
    { id: "plan", kind: "agent", prompt: "Plan {{input:feature}}" },
    { id: "approve", kind: "ask", question: "Approve the plan?", choices: ["Yes", "No"] },
    { id: "build", kind: "agent", prompt: "Build it", worktree: true },
    { id: "tests", kind: "gate", check: "tests" },
  ],
  edges: [
    { from: "plan", to: "approve" },
    { from: "approve", to: "build" },
    { from: "build", to: "tests" },
  ],
  ...overrides,
});

describe("parseCommandCenterWorkflow", () => {
  it("accepts a valid graph and fills the defaults", () => {
    const parsed = parseCommandCenterWorkflow(workflow());
    expect(parsed.errors).toEqual([]);
    expect(parsed.workflow).toMatchObject({ description: "", layout: {} });
    expect(parsed.workflow?.nodes[0]).toEqual({
      id: "plan",
      kind: "agent",
      prompt: "Plan {{input:feature}}",
      skills: [],
      worktree: false,
      outputs: "text",
    });
  });

  it("names unknown kinds and bad nodes instead of failing the whole union", () => {
    const parsed = parseCommandCenterWorkflow(
      workflow({
        nodes: [
          { id: "plan", kind: "loop" },
          { id: "build", kind: "agent" },
        ],
      }),
    );
    expect(parsed.workflow).toBeNull();
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toBe(
      'Node "plan" has unknown kind "loop"; use agent, skill, ask, parallel, gate.',
    );
    expect(parsed.errors[1]).toMatch(/^Node "build": .*prompt/);
  });

  it("reports repeated ids, dangling, self and repeated edges, and cycles", () => {
    const parsed = parseCommandCenterWorkflow(
      workflow({
        nodes: [
          { id: "a", kind: "gate", check: "manual" },
          { id: "b", kind: "gate", check: "manual" },
          { id: "b", kind: "gate", check: "tests" },
        ],
        inputs: [],
        edges: [
          { from: "a", to: "b" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
          { from: "a", to: "a" },
          { from: "a", to: "ghost" },
        ],
      }),
    );
    expect(parsed.errors).toEqual([
      'Node id "b" is used more than once.',
      'Edge from "a" to "b" is listed twice.',
      'Edge from "a" to itself.',
      'Edge from "a" to "ghost" points at a missing node.',
      "The edges form a cycle: a -> b -> a.",
    ]);
  });

  it("checks parallel bodies and input references", () => {
    const parsed = parseCommandCenterWorkflow(
      workflow({
        nodes: [
          { id: "fan", kind: "parallel", over: "files", node: "review" },
          { id: "review", kind: "agent", prompt: "Review {{input:file}}" },
          { id: "other", kind: "parallel", over: "nowhere", node: "review" },
          { id: "gate", kind: "gate", check: "tests" },
        ],
        inputs: [{ name: "files", label: "Files" }],
        edges: [{ from: "review", to: "gate" }],
      }),
    );
    expect(parsed.errors).toEqual([
      'Node "review" runs inside "fan", so it cannot have edges; connect "fan" instead.',
      'Node "review" is run by both "fan" and "other".',
      'Parallel node "other" runs over "nowhere", which is neither an input nor another node.',
      'Node "review" uses {{input:file}}, which is not declared in inputs.',
    ]);
  });

  it("refuses a parallel node over a body node, or over a node that waits for it", () => {
    const overBody = parseCommandCenterWorkflow(
      workflow({
        inputs: [],
        nodes: [
          { id: "fan", kind: "parallel", over: "review", node: "review" },
          { id: "review", kind: "agent", prompt: "Review" },
        ],
        edges: [],
      }),
    );
    expect(overBody.errors).toEqual([
      'Parallel node "fan" runs over "review", which runs inside "fan"; use "fan" instead.',
    ]);
    const loop = parseCommandCenterWorkflow(
      workflow({
        inputs: [],
        nodes: [
          { id: "fan", kind: "parallel", over: "list", node: "review" },
          { id: "review", kind: "agent", prompt: "Review" },
          { id: "list", kind: "agent", prompt: "List" },
        ],
        edges: [{ from: "fan", to: "list" }],
      }),
    );
    expect(loop.errors).toEqual(["The edges form a cycle: fan -> list -> fan."]);
  });

  it("rejects what is not a workflow object or has a bad slug", () => {
    expect(parseCommandCenterWorkflow([]).errors).toEqual(["A workflow is a JSON object."]);
    const parsed = parseCommandCenterWorkflow(workflow({ slug: "Not A Slug" }));
    expect(parsed.workflow).toBeNull();
    expect(parsed.errors[0]).toContain("slug");
    const reserved = parseCommandCenterWorkflow(workflow({ slug: "nul" }));
    expect(reserved.errors[0]).toContain("reserved on Windows");
  });
});

describe("parseWorkflowCommand", () => {
  it("reads the slug, quoted inputs and free text, and plans them onto inputs", () => {
    const command = parseWorkflowCommand('/wf Bugfix since="v1 2" login fails');
    expect(command).toEqual({ slug: "bugfix", inputs: { since: "v1 2" }, text: "login fails" });
    expect(parseWorkflowCommand("fix /wf")).toBeNull();
    expect(
      planWorkflowInputs(
        [
          { name: "since", label: "Since", default: "main" },
          { name: "bug", label: "Bug" },
        ],
        { inputs: {}, text: "login fails" },
      ),
    ).toEqual({ inputs: { bug: "login fails" }, missing: [], unknown: [], leftover: "" });
  });
});
