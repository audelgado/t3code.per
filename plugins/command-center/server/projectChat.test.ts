import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, replaceProjects } from "./db.ts";
import { createProjectChat } from "./projectChat.ts";
import type { LaunchInput, LinkState, T3Link, ThreadRow } from "./types.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-chat-"));
  const db = openDb(home);
  replaceProjects(db, "m", ["a", "b"].map((id) => ({ machineId: "m", id, title: id, workspaceRoot: "/app/" + id, defaultModel: null, updatedAt: "" })));
  const launches: LaunchInput[] = [];
  const messages: unknown[][] = [];
  const rows: ThreadRow[] = [];
  let fail = false;
  const link: T3Link = {
    machineId: "m", state: { status: "online", since: "", degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: null, message: null } satisfies LinkState,
    launch: async (input) => { launches.push(input); if (fail) throw new Error("Transport failed"); },
    sendMessage: async (...args) => { messages.push(args); },
    interrupt: async () => {}, respond: async () => {}, settle: async () => {}, close: () => {},
    providers: async () => [{ instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, models: [{ slug: "model", name: "Model", isDefault: true }] }],
    readResult: async () => ({ text: "Hola", pending: null, messages: [{ id: "first", role: "user", text: launches[0]!.prompt, createdAt: "a", streaming: false }, { id: "reply", role: "assistant", text: "Hola", createdAt: "b", streaming: false }] }),
    session: async () => ({ expiresAt: null, scopes: [] }),
  };
  const make = () => createProjectChat({ db, link: () => link, threads: () => rows, activity: () => [] });
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  return { make, launches, messages, rows, fail: (v: boolean) => { fail = v; } };
}
const first = { text: "Revisa el proyecto", commandId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };

test("one durable orchestrator per project; follow-ups queue in the same T3 thread, even after service restart", async (t) => {
  const s = setup(t);
  const a = await s.make().send("m", "a", first);
  assert.deepEqual(await s.make().send("m", "a", first), a);
  assert.equal(s.launches.length, 1);
  const history = await s.make().read("m", "a");
  assert.equal(history.messages[0]!.text, first.text);
  assert.equal(history.messages[1]!.text, "Hola");
  await s.make().send("m", "a", { text: "Continúa", commandId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
  assert.deepEqual(s.messages[0], [a.threadId, "Continúa", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "queue_after_active"]);
  const b = await s.make().send("m", "b", first);
  assert.notEqual(b.threadId, a.threadId);
  assert.equal(s.launches[0]!.runtimeMode, "full-access");
});

test("a transport retry reuses launch IDs and never silently replaces the first request", async (t) => {
  const s = setup(t);
  s.fail(true);
  await assert.rejects(s.make().send("m", "a", first), /Transport/);
  assert.deepEqual((await s.make().read("m", "a")).retry, { commandId: first.commandId, text: first.text });
  await assert.rejects(s.make().send("m", "a", { ...first, commandId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }), /primer envío/);
  s.fail(false);
  await s.make().send("m", "a", first);
  assert.equal(s.launches[0]!.threadId, s.launches[1]!.threadId);
  assert.equal(s.launches[0]!.commandId, s.launches[1]!.commandId);
  await assert.rejects(s.make().send("m", "missing", first), /proyecto/);
  await assert.rejects(s.make().send("m", "a", { ...first, runtimeMode: "bogus" }), /Permisos/);
});

test("adopting an existing conversation preserves its thread and rejects another project's thread or a child", async (t) => {
  const s = setup(t);
  s.rows.push({ machineId: "m", id: "existing", projectId: "a", title: "Existing work", status: "completed", activityRunStatus: null, activeRunId: null, pendingRequest: null, hasActionableProposedPlan: false, lastError: null, usageLimitResetAt: null, relationshipToParent: null, snoozedUntil: null, settledAt: null, providerInstanceId: "codex", completedAt: "", createdAt: "", updatedAt: "" });
  const service = s.make();
  assert.equal((await service.read("m", "a")).conversations?.[0]?.threadId, "existing");
  assert.equal(service.bind("m", "a", "existing").threadId, "existing");
  await service.send("m", "a", first);
  assert.equal(s.launches.length, 0);
  assert.equal(s.messages[0]![0], "existing");
  assert.throws(() => service.bind("m", "b", "existing"), /pertenece/);
  s.rows[0]!.relationshipToParent = "subagent";
  assert.throws(() => service.bind("m", "a", "existing"), /pertenece/);
});
