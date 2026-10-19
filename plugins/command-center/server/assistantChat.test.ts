import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { createAssistantChat } from "./assistantChat.ts";
import { createOrganize } from "./organize.ts";
import type { AssistantContext } from "./assistant.ts";
import { T3Error, type ChatMessage, type LaunchInput, type Machine, type T3Link, type ThreadRow } from "./types.ts";

const first = { coordinator: "codex" as const, text: "Revisa mi cola", commandId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
const second = { ...first, text: "Continúa", commandId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
function setup(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-assistant-"));
  let db = openDb(home);
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const launches: LaunchInput[] = [];
  const sends: unknown[][] = [];
  const interrupts: unknown[][] = [];
  const rows: ThreadRow[] = [];
  const messages: ChatMessage[] = [];
  let fail = false; let changes = 0; let applied = 0;
  const machine: Machine = { id: "m", label: "Equipo", apiUrl: "PRIVATE_URL", webUrl: null, maxConcurrent: 2, enabled: true, serverVersion: null, tokenExpiresAt: null, createdAt: "" };
  const link: T3Link = {
    machineId: "m", state: { status: "online", since: "", degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: null, message: null },
    launch: async (input) => { launches.push(input); if (fail) throw new Error("Transport failed"); },
    sendMessage: async (...args) => { sends.push(args); if (fail) throw new Error("Transport failed"); },
    interrupt: async (...args) => { interrupts.push(args); }, respond: async () => { throw new Error("never approve"); }, settle: async () => {}, close: () => {},
    providers: async () => [{ instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, models: [{ slug: "model", name: "Model", isDefault: true }] }],
    readResult: async () => ({ messages: [...messages], text: messages.at(-1)?.text ?? null, pending: null }),
    session: async () => ({ expiresAt: null, scopes: [] }),
  };
  const context: AssistantContext = { projects: ["a", "b"].map((id) => ({ machineId: "m", id, title: `Project-${id}`, workspaceRoot: "PRIVATE_PATH", defaultModel: null, updatedAt: "" })), tasks: [], view: { machines: [{ ...machine, link: link.state, running: 0, queued: 0 }], needsYou: [], queue: [], running: [], done: [] } };
  const organizer = createOrganize({ machines: () => [machine], projects: () => context.projects, profiles: () => [], link: () => link, threads: () => rows });
  const make = () => createAssistantChat({ db, context: () => context, coordinators: organizer.coordinators, link: () => link, threads: () => rows, apply: async () => { applied++; return "task1"; }, onChange: () => { changes++; } });
  const complete = (id: string, answer = "Listo", actions: unknown[] = []) => {
    messages.push({ id, role: "assistant", text: JSON.stringify({ answer, actions }), createdAt: id, streaming: false });
    rows.splice(0, rows.length, { machineId: "m", id: launches.at(-1)!.threadId, projectId: "a", title: "Assistant", status: "completed", activityRunStatus: null, activeRunId: null, pendingRequest: null, hasActionableProposedPlan: false, lastError: null, usageLimitResetAt: null, relationshipToParent: null, snoozedUntil: null, settledAt: null, providerInstanceId: "codex", completedAt: id, createdAt: "", updatedAt: id });
  };
  return { make, launches, sends, rows, messages, context, link, interrupts, complete, fail: (v: boolean) => { fail = v; }, changes: () => changes, applied: () => applied,
    reopen: () => { db.close(); db = openDb(home); } };
}

test("reload and server restart retain dialogue, pending turn and native thread; stale replies never complete a follow-up", async (t) => {
  const s = setup(t);
  let service = s.make();
  await service.send(first);
  assert.equal(s.launches[0]!.runtimeMode, "approval-required");
  s.complete("reply1", "Primera respuesta");
  await service.advance();
  s.reopen(); service = s.make();
  assert.equal((await service.read(first)).messages.at(-1)?.text, "Primera respuesta");
  assert.equal(service.owns("m", s.launches[0]!.threadId), true);
  await service.send(second);
  assert.equal((await service.read(first)).status, "running");
  assert.equal(s.launches.length, 1);
  assert.equal(s.sends[0]![0], s.launches[0]!.threadId);
  assert.doesNotMatch(String(s.sends[0]![1]), /asistente exclusivo|Primera respuesta|Conversación reciente/);
  assert.match(String(s.sends[0]![1]), /sin cambios/);
  assert.doesNotMatch(String(s.sends[0]![1]), /Project-a/);
  s.reopen(); service = s.make();
  assert.equal((await service.read(first)).status, "running");
  s.complete("reply2", "Segunda respuesta");
  await service.advance();
  const restored = await s.make().read(first);
  assert.equal(restored.status, "idle");
  assert.deepEqual(restored.messages.map((m) => m.text), [first.text, "Primera respuesta", second.text, "Segunda respuesta"]);
  await service.send(second);
  assert.equal(s.sends.length, 1);
  await assert.rejects(service.send({ ...second, text: "Otro mensaje" }), /otro mensaje/);
  assert.ok(s.changes() >= 4);
});

test("a changed operational snapshot replaces the old state without resending history", async (t) => {
  const s = setup(t); const service = s.make();
  await service.send(first); s.complete("reply1", "Respuesta anterior"); await service.advance();
  s.context.projects[0]!.title = "Nombre actualizado";
  await service.send(second);
  assert.match(String(s.sends[0]![1]), /Nombre actualizado/);
  assert.doesNotMatch(String(s.sends[0]![1]), /Respuesta anterior|asistente exclusivo/);
});

test("commentary during reconnect is ignored until T3 commits a terminal run", async (t) => {
  const s = setup(t); const service = s.make();
  await service.send(first);
  s.messages.push({ id: "commentary", role: "assistant", text: "Voy a revisar", streaming: false, createdAt: "now" });
  await service.advance();
  assert.equal((await service.read(first)).status, "running");
  s.complete("reply1"); s.rows[0]!.status = "running"; s.rows[0]!.activeRunId = "run1";
  await service.advance();
  assert.equal((await service.read(first)).status, "running");
  s.rows[0]!.status = "completed"; s.rows[0]!.activeRunId = null;
  await service.advance();
  assert.equal((await service.read(first)).status, "idle");
});

test("a definite launch rejection can be corrected with a new command without sending to a nonexistent thread", async (t) => {
  const s = setup(t); const service = s.make(); const launch = s.link.launch;
  s.link.launch = async (input) => { await launch(input); throw new T3Error("fail", "Rejected"); };
  assert.equal((await service.send(first)).status, "failed");
  s.link.launch = launch;
  await service.send(second);
  assert.equal(s.sends.length, 0);
  assert.equal(s.launches[0]!.threadId, s.launches[1]!.threadId);
  assert.notEqual(s.launches[0]!.commandId, s.launches[1]!.commandId);
  assert.match(s.launches[1]!.prompt, /Continúa/);
  s.complete("reply1"); await service.advance();
  assert.equal((await service.read(first)).status, "idle");
});

test("uncertain launch and follow-up delivery reuse durable IDs after restart", async (t) => {
  const s = setup(t); s.fail(true);
  await assert.rejects(s.make().send(first), /Transport/);
  const pending = await s.make().read(first);
  assert.deepEqual(pending.retry, { text: first.text, commandId: first.commandId });
  await assert.rejects(s.make().send(second), /pendiente/);
  s.fail(false); await s.make().send(first);
  assert.deepEqual(s.launches[0], s.launches[1]);
  s.complete("reply1"); await s.make().advance();
  s.fail(true); await assert.rejects(s.make().send(second), /Transport/);
  s.fail(false); await s.make().send(second);
  assert.deepEqual(s.sends[0], s.sends[1]);
  assert.equal((await s.make().read(first)).messages.filter((m) => m.id === second.commandId).length, 1);
});

test("project scope isolates context, history and proposals, and cannot act on another project", async (t) => {
  const s = setup(t); const service = s.make();
  const scoped = { ...first, projectKey: "m:a" };
  await service.send(scoped);
  assert.match(s.launches[0]!.prompt, /Project-a/);
  assert.doesNotMatch(s.launches[0]!.prompt, /Project-b|PRIVATE_/);
  s.complete("reply1", "Proyecto A", [{ type: "delegate", projectKey: "m:b", title: "Otro", prompt: "No" }, { type: "delegate", projectKey: "m:a", title: "Revisar", prompt: "Revisa" }]);
  await service.advance();
  assert.equal((await service.read(scoped)).messages.at(-1)?.reply?.actions.length, 1);
  assert.equal((await service.read(first)).messages.length, 0);
  await service.send({ ...first, projectKey: "m:b" });
  assert.notEqual(s.launches[0]!.threadId, s.launches[1]!.threadId);
  assert.equal(s.launches[1]!.projectId, "b");
});

test("applied proposals stay applied after restart; stale actions are revalidated", async (t) => {
  const s = setup(t); let service = s.make();
  await service.send(first);
  s.complete("reply1", "Propuesta", [{ type: "delegate", projectKey: "m:a", title: "Revisar", prompt: "Revisa" }]);
  await service.advance();
  const action = { ...first, messageId: "reply1", index: 0, runtimeMode: "auto-accept-edits" as const };
  await service.apply(action);
  s.reopen(); service = s.make();
  await service.apply(action);
  assert.equal(s.applied(), 1);
  assert.deepEqual((await service.read(first)).messages.find((m) => m.id === "reply1")?.applied, [0]);
  await service.send(second);
  assert.match(String(s.sends[0]![1]), /acciones confirmadas.*task1/s);
  s.complete("reply2", "Propuesta", [{ type: "delegate", projectKey: "m:b", title: "Revisar", prompt: "Revisa" }]); await service.advance();
  s.context.projects.pop();
  await assert.rejects(service.apply({ ...action, messageId: "reply2" }), /estado cambió/);
  assert.equal(s.applied(), 1);
});

test("a pending tool approval stops the assistant and is never approved", async (t) => {
  const s = setup(t); const service = s.make();
  await service.send(first); s.complete("reply1");
  s.rows[0] = { ...s.rows[0]!, activeRunId: "run1", status: "running", pendingRequest: { id: "permission1", kind: "command", summary: "Run tool", createdAt: "" } };
  await service.advance();
  assert.equal((await service.read(first)).status, "failed");
  assert.equal(s.interrupts.length, 1);
});
