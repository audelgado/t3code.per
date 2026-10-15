import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintPairing } from "./auth.ts";
import { openDb } from "./db.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createServer } from "./http.ts";
import { createMcp } from "./mcp.ts";
import { deleteMemory, initMemory, listMemory, memoryRoutes, memoryTools, recallMemory, saveMemory, setMemoryDone } from "./memory.ts";

const PUBLIC = "https://cc.tailnet.ts.net:8443";
const HOST = "cc.tailnet.ts.net:8443";

function fresh(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-mem-"));
  const db = openDb(home);
  initMemory(db);
  t.after(() => (db.close(), rmSync(home, { recursive: true, force: true })));
  return db;
}
/** Inserts with a fixed timestamp so ordering is deterministic. */
function at(db: ReturnType<typeof fresh>, iso: string, input: Record<string, unknown>) {
  const e = saveMemory(db, { kind: "note", ...input }, "user");
  db.prepare("update cc_memory set created_at = ?, updated_at = ? where id = ?").run(iso, iso, e.id);
  return e.id;
}
const day = (d: number, h = 9) => new Date(Date.UTC(2026, 9, d, h)).toISOString();

test("list: newest first, project/kind/search filters combine", (t) => {
  const db = fresh(t);
  const a = at(db, day(1), { projectId: "p1", kind: "todo", text: "Ship the API" });
  const b = at(db, day(2), { projectId: "p1", kind: "note", text: "ship notes" });
  const c = at(db, day(3), { kind: "todo", text: "Ship docs" });
  const ids = (i: Parameters<typeof listMemory>[1]) => listMemory(db, i).entries.map((e) => e.id);
  assert.deepEqual(ids({}), [c, b, a]);
  assert.deepEqual(ids({ projectId: "p1", kind: "todo", query: "SHIP" }), [a]);
  assert.deepEqual(ids({ projectId: null }), [c]);
  assert.deepEqual(ids({ query: "notes" }), [b]);
  assert.deepEqual(ids({ query: "100%" }), []); // LIKE wildcards are literal
  assert.deepEqual(ids({ kind: "todo", done: false }), [c, a]);
});

test("list pages with a keyset cursor that survives deleting the cursor entry", (t) => {
  const db = fresh(t);
  const made = Array.from({ length: 107 }, (_, i) => at(db, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), { text: `n${i}` }));
  const all: string[] = [];
  let page = listMemory(db, { limit: 25 });
  all.push(...page.entries.map((e) => e.id));
  while (page.hasMore) {
    const last = page.entries.at(-1)!;
    page = listMemory(db, { limit: 25, before: last.id, beforeCreatedAt: last.createdAt });
    all.push(...page.entries.map((e) => e.id));
  }
  assert.deepEqual(all, made.toReversed());

  // Cursor entry deleted meanwhile: the value cursor still resumes where it was.
  const cursor = listMemory(db, { limit: 5 }).entries.at(-1)!;
  deleteMemory(db, cursor.id);
  const next = listMemory(db, { limit: 5, before: cursor.id, beforeCreatedAt: cursor.createdAt });
  assert.deepEqual(next.entries.map((e) => e.id), made.toReversed().slice(5, 10));
  // The extra row is only a probe: exactly `limit` entries left means no more.
  assert.equal(listMemory(db, { limit: 100 }).hasMore, true);
  assert.equal(listMemory(db, { limit: 100, before: made[5]!, beforeCreatedAt: new Date(Date.UTC(2026, 9, 1, 0, 5)).toISOString() }).hasMore, false);
});

test("recall: newest progress per project, open todos oldest first, clipped text, project scope", (t) => {
  const db = fresh(t);
  at(db, day(1), { kind: "progress", projectId: "p1", text: "old p1" });
  at(db, day(3), { kind: "progress", projectId: "p1", text: "new p1" });
  at(db, day(2), { kind: "progress", projectId: "p2", text: "p2" });
  const t1 = at(db, day(1), { kind: "todo", projectId: "p1", text: "first" });
  const t2 = at(db, day(2), { kind: "todo", projectId: "p2", text: "second" });
  at(db, day(4), { kind: "decision", text: "x".repeat(900) });
  at(db, day(4), { kind: "handoff", text: "pass it on" });
  at(db, day(4), { kind: "note", text: "not recalled" });

  const r = recallMemory(db);
  assert.deepEqual(r.progress.map((e) => e.text), ["new p1", "p2"]);
  assert.deepEqual(r.openTodos.map((e) => e.id), [t1, t2]);
  assert.equal(r.decisions[0]!.text.length, 600);
  assert.equal(r.handoffs.length, 1);

  const p2 = recallMemory(db, "p2");
  assert.deepEqual(p2.progress.map((e) => e.text), ["p2"]);
  assert.deepEqual(p2.openTodos.map((e) => e.id), [t2]);
  assert.equal(p2.decisions.length, 0);

  setMemoryDone(db, t1, true);
  assert.deepEqual(recallMemory(db).openTodos.map((e) => e.id), [t2]);
  assert.equal(setMemoryDone(db, t1, false).done, false); // reopen
  assert.deepEqual(recallMemory(db).openTodos.map((e) => e.id), [t1, t2]);
  assert.throws(() => setMemoryDone(db, "missing", true), /not found/);
});

test("save validates input and records the source", (t) => {
  const db = fresh(t);
  assert.throws(() => saveMemory(db, { kind: "bogus", text: "x" }, "agent"), /kind/);
  assert.throws(() => saveMemory(db, { kind: "note", text: "   " }, "agent"), /text/);
  assert.throws(() => saveMemory(db, { kind: "note", text: "x".repeat(20_001) }, "agent"), /20000/);
  assert.throws(() => saveMemory(db, { kind: "note", text: "x", projectId: 5 }, "agent"), /projectId/);
  const e = saveMemory(db, { kind: "todo", text: "  do it  ", projectId: "p1" }, "agent");
  assert.deepEqual([e.text, e.source, e.done, e.projectId, e.sectionId], ["do it", "agent", false, "p1", null]);
});

test("MCP tools and PWA routes end to end", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "cc-mem-"));
  const db = openDb(home);
  const mcp = createMcp({ db, tasks: new Dispatcher({ db, link: () => undefined }), machines: () => [] });
  mcp.registerTools(memoryTools(db));
  const server: Server = await createServer({
    routes: [...mcp.routes, ...memoryRoutes(db)],
    publicUrl: PUBLIC,
    db,
    staticDir: join(home, "dist"),
    port: 0,
    verifyBearer: mcp.verifyBearer,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; json: any; cookie: string }>((ok, ko) => {
      const { port } = server.address() as AddressInfo;
      const r = request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, "content-type": "application/json", ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => ok({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined, cookie: String(res.headers["set-cookie"]?.[0]).split(";")[0]! }));
      });
      r.on("error", ko);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });

  const paired = await send("POST", "/api/pair", { token: mintPairing(db) }, { origin: PUBLIC });
  const web = { origin: PUBLIC, cookie: paired.cookie };
  const agent = await send("POST", "/api/agents", { label: "hermes" }, web);
  const bearer = { authorization: `Bearer ${agent.json.token}` };
  let id = 1;
  const call = async (name: string, args: unknown) => {
    const res = await send("POST", "/mcp", { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, bearer);
    const r = res.json.result;
    return { isError: r.isError as boolean, text: r.content[0].text as string };
  };

  const saved = await call("memory_save", { kind: "todo", text: "Add Stripe keys", projectId: "p1" });
  assert.equal(saved.isError, false);
  const entry = JSON.parse(saved.text);
  assert.equal(entry.source, "agent");
  assert.equal((await call("memory_save", { kind: "nope", text: "x" })).isError, true);
  assert.deepEqual(JSON.parse((await call("memory_recall", {})).text).openTodos.map((e: any) => e.id), [entry.id]);
  assert.equal(JSON.parse((await call("memory_complete", { id: entry.id })).text).done, true);
  assert.deepEqual(JSON.parse((await call("memory_recall", { projectId: "p1" })).text).openTodos, []);
  assert.equal((await call("memory_complete", { id: "missing" })).isError, true);

  // The PWA sees the agent's entry; its own entries are source "user".
  assert.equal((await send("POST", "/api/memory/list", {})).status, 401);
  const listed = await send("POST", "/api/memory/list", { query: "stripe" }, web);
  assert.deepEqual(listed.json.entries.map((e: any) => e.id), [entry.id]);
  const mine = await send("POST", "/api/memory", { kind: "note", text: "hello" }, web);
  assert.equal(mine.json.source, "user");
  assert.equal((await send("POST", "/api/memory", { kind: "note", text: "" }, web)).status, 400);
  assert.equal((await send("POST", `/api/memory/${entry.id}/done`, { done: false }, web)).json.done, false);
  assert.equal((await send("POST", "/api/memory/list", { kind: "x" }, web)).status, 400);
  assert.equal((await send("DELETE", `/api/memory/${mine.json.id}`, undefined, web)).status, 200);
  assert.equal((await send("DELETE", `/api/memory/${mine.json.id}`, undefined, web)).status, 404);
});
