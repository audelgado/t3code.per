import assert from "node:assert/strict";
import { test } from "node:test";
import type { StepView, Workflow } from "../../server/workflows.ts";
import { canCancel, canResume, errorLines, lastRunBySlug, newWorkflowText, nodeStates, orderNodes, orderRuns, parseDraft, progress, runInputs, runTone, slugify, threadLinks, uniqueSlug, waitingStep } from "./workflowView.ts";

const step = (nodeId: string, status: StepView["status"], item: number | null = null): StepView => ({
  id: `${nodeId}${item}`, runId: "r", nodeId, item, status, taskId: null, output: null, error: null, createdAt: "", updatedAt: "", taskStatus: null, threadId: null,
});
const wf: Workflow = {
  slug: "w", title: "W", description: "", inputs: [],
  nodes: [{ id: "c", kind: "gate", check: "manual" }, { id: "a", kind: "agent", prompt: "x" }, { id: "b", kind: "agent", prompt: "y" }],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
};

test("orderNodes follows the edges, not the file order", () => {
  assert.deepEqual(orderNodes(wf).map((n) => n.id), ["a", "b", "c"]);
  const loop = { ...wf, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
  assert.equal(orderNodes(loop).length, 3);
});

test("slugs", () => {
  assert.equal(slugify("  Release Notes! "), "release-notes");
  assert.equal(slugify("???"), "workflow");
  assert.equal(uniqueSlug("Release", new Set(["release", "release-2"])), "release-3");
  assert.equal((JSON.parse(newWorkflowText("My flow", new Set(["my-flow"]))) as Workflow).slug, "my-flow-2");
});

test("parseDraft reports bad JSON", () => {
  assert.deepEqual(parseDraft('{"a":1}'), { value: { a: 1 } });
  assert.match((parseDraft("{") as { error: string }).error, /^JSON inválido/);
  assert.deepEqual(errorLines("a\n\n b \n"), ["a", " b "]);
});

test("runInputs trims, leaves defaults to the server and names missing required inputs", () => {
  const defs = [{ name: "a", label: "A" }, { name: "b", label: "B", default: "d" }, { name: "c", label: "C" }];
  assert.deepEqual(runInputs(defs, { a: " x ", c: "  " }), { inputs: { a: "x" }, missing: ["C"] });
});

test("orderRuns puts waiting first, then running, newest first", () => {
  const r = (id: string, status: "running" | "needs_you" | "succeeded", createdAt: string) => ({ id, status, createdAt, slug: id });
  const runs = [r("old", "succeeded", "3"), r("run", "running", "2"), r("wait", "needs_you", "1"), r("new", "succeeded", "4")];
  assert.deepEqual(orderRuns(runs).map((x) => x.id), ["wait", "run", "new", "old"]);
  assert.equal(lastRunBySlug([r("a", "running", "2"), r("a", "succeeded", "1")]).get("a")?.status, "running");
});

test("nodeStates takes the worst step per node and counts progress", () => {
  const steps = [step("a", "succeeded"), step("b", "running", 0), step("b", "failed", 1)];
  const s = nodeStates(wf.nodes, steps);
  assert.equal(s.get("a")?.status, "succeeded");
  assert.equal(s.get("b")?.status, "running");
  assert.equal(s.get("c")?.status, "pending");
  assert.equal(progress(wf, steps), "1 de 3 pasos listos");
});

test("run actions and thread links", () => {
  assert.ok(canCancel("needs_you") && !canCancel("failed"));
  assert.ok(canResume("cancelled") && !canResume("running"));
  assert.deepEqual(threadLinks({ id: "m", webUrl: "https://x/" }, "t"), { appUrl: "t3code://threads/m/t", webUrl: "https://x/m/t" });
  assert.equal(threadLinks({ id: "m", webUrl: null }, "t").webUrl, null);
});

test("a run waits on the first ask or manual gate with a waiting step, and statuses map to tones", () => {
  assert.equal(waitingStep(wf, [step("a", "succeeded"), step("b", "succeeded"), step("c", "waiting")])?.node.id, "c");
  assert.equal(waitingStep(wf, [step("a", "running")]), null);
  assert.equal(waitingStep(wf, [step("b", "waiting", 0)]), null);
  assert.deepEqual(["needs_you", "pending_approval", "succeeded", "failed", "running", "cancelled"].map((s) => runTone(s as "running")), ["need", "need", "ok", "fail", "run", "queue"]);
});
