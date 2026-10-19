import assert from "node:assert/strict";
import { test } from "node:test";
import { assistantPrompt, assistantState, parseAssistantReply, scopeAssistantContext, type AssistantContext } from "./assistant.ts";
import type { Task } from "./types.ts";

const task = (id: string, status: Task["status"]): Task => ({
  id, status, title: id, machineId: "pc", projectId: "app", prompt: "PRIVATE_TASK_PROMPT", source: "user", model: null, runtimeMode: "auto-accept-edits", interactionMode: "default", workspace: { type: "root" }, priority: 0, dependsOn: [], commandId: null, threadId: null, threadSeenAt: null, limitResetAt: null, error: null, result: "PRIVATE_TASK_RESULT", createdAt: "", updatedAt: "", startedAt: null, finishedAt: null,
});
const context = (): AssistantContext => ({
  tasks: [task("cancelled", "cancelled"), { ...task("queued", "queued"), dependsOn: ["cancelled"] }, task("approval", "pending_approval"), task("done", "done")],
  projects: [{ machineId: "pc", id: "app", title: "App", workspaceRoot: "PRIVATE_PATH", defaultModel: null, updatedAt: "" }],
  view: { machines: [{ id: "pc", label: "PC", apiUrl: "PRIVATE_URL", webUrl: null, maxConcurrent: 2, enabled: true, serverVersion: null, tokenExpiresAt: null, createdAt: "", running: 0, queued: 1, link: { status: "online", since: "", degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: null, message: null } }], queue: [], running: [], done: [], needsYou: [] },
});

test("the assistant sees cancelled predecessors and actual constraints without private configuration or work contents", () => {
  const prompt = assistantPrompt("¿Por qué espera?", [], context());
  assert.match(prompt, /cancelled.*cancelada/s);
  assert.match(prompt, /pc:app/);
  assert.doesNotMatch(prompt, /PRIVATE_/);
});

test("assistant proposals reject invented IDs, arbitrary operations, completed tasks and duplicate actions", () => {
  const reply = parseAssistantReply(JSON.stringify({ answer: "Reintentá el paso", actions: [
    { type: "retry", taskId: "cancelled" }, { type: "retry", taskId: "cancelled" }, { type: "retry", taskId: "done" }, { type: "cancel", taskId: "invented" }, { type: "exec", taskId: "queued" },
  ] }), context())!;
  assert.deepEqual(reply.actions, [{ type: "retry", taskId: "cancelled", title: "cancelled" }]);
  const delegates = parseAssistantReply(JSON.stringify({ answer: "Propuesta", actions: [
    { type: "delegate", projectKey: "pc:app", title: "Revisar", prompt: "Revisá" }, { type: "delegate", projectKey: "pc:missing", title: "Revisar", prompt: "Revisá" }, { type: "approve", taskId: "approval" },
  ] }), context())!;
  assert.equal(delegates.actions.length, 2);
  assert.equal(parseAssistantReply("invalid", context()), null);
  assert.equal(parseAssistantReply('{"actions":[]}', context()), null);
});

test("a project excludes unrelated work but preserves cross-project dependency states", () => {
  const c = context();
  c.tasks.push({ ...task("external", "failed"), projectId: "other", title: "UNRELATED_TITLE" });
  c.tasks[1]!.dependsOn = ["external"];
  c.projects.push({ ...c.projects[0]!, id: "other", title: "UNRELATED_PROJECT" });
  const scoped = scopeAssistantContext(c, "pc:app");
  const state = assistantState(scoped);
  assert.equal(state.dependencies.find((d) => d.id === "external")?.status, "failed");
  assert.match(state.tasks.find((t) => t.id === "queued")!.reason!, /falló/);
  assert.doesNotMatch(JSON.stringify(state), /UNRELATED/);
  const reply = parseAssistantReply(JSON.stringify({ answer: "Propuesta", actions: [{ type: "retry", taskId: "external" }] }), scoped);
  assert.deepEqual(reply?.actions, []);
});

test("large installations send a bounded operational sample and retain accurate totals", () => {
  const c = context();
  c.projects = Array.from({ length: 150 }, (_, i) => ({ ...c.projects[0]!, id: `p${i}`, title: `Project ${i}` }));
  c.tasks = Array.from({ length: 150 }, (_, i) => ({ ...task(`t${i}`, "queued"), projectId: `p${i}` }));
  c.tasks[149]!.status = "needs_you";
  const state = assistantState(c);
  assert.equal(state.totals.projects, 150);
  assert.equal(state.totals.activeTasks, 150);
  assert.equal(state.tasks.length, 30);
  assert.ok(state.projects.length <= 30);
  assert.equal(state.tasks[0]?.id, "t149");
  assert.ok(JSON.stringify(state).length < 18000);
});
