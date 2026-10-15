import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintPairing } from "./auth.ts";
import { getTask, openDb, replaceProjects, upsertMachine } from "./db.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createServer } from "./http.ts";
import { createMcp, resolveProject, ToolError } from "./mcp.ts";
import type { MachineView, ProjectRow } from "./types.ts";

const PUBLIC = "https://cc.tailnet.ts.net:8443";
const HOST = "cc.tailnet.ts.net:8443";
const T0 = "2026-10-15T00:00:00.000Z";

const project = (machineId: string, id: string, title: string, workspaceRoot: string): ProjectRow => ({
  machineId,
  id,
  title,
  workspaceRoot,
  defaultModel: null,
  updatedAt: T0,
});

async function setup(t: { after(fn: () => Promise<void> | void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-mcp-"));
  const db = openDb(home);
  for (const [id, label] of [["m1", "VPS"], ["m2", "PC"]] as const)
    upsertMachine(db, { id, label, apiUrl: `https://${id}`, webUrl: null, maxConcurrent: 2, enabled: true, serverVersion: null, tokenExpiresAt: null, createdAt: T0 });
  replaceProjects(db, "m1", [project("m1", "p-app", "App", "/srv/app"), project("m1", "p-web", "Web", "/srv/app/web"), project("m1", "p-api", "Api", "/srv/api")]);
  replaceProjects(db, "m2", [project("m2", "p-pc", "App", "C:\\Work\\App")]);
  const dispatcher = new Dispatcher({ db, link: () => undefined });
  const machines = (): MachineView[] => [];
  const mcp = createMcp({ db, tasks: dispatcher, machines });
  const server = await createServer({ routes: mcp.routes, publicUrl: PUBLIC, db, staticDir: join(home, "dist"), port: 0, verifyBearer: mcp.verifyBearer });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const pair = await req(server, "POST", "/api/pair", { token: mintPairing(db) }, { origin: PUBLIC });
  const cookie = String(pair.headers["set-cookie"]?.[0]).split(";")[0]!;
  const newAgent = async (label: string) => {
    const res = await req(server, "POST", "/api/agents", { label }, { origin: PUBLIC, cookie });
    assert.equal(res.status, 200);
    return res.json.token as string;
  };
  return { server, db, home, cookie, newAgent };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: any;
}
function req(server: Server, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const { port } = server.address() as AddressInfo;
  return new Promise((ok, ko) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, text, json: text ? JSON.parse(text) : undefined }));
    });
    r.on("error", ko);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

let nextId = 1;
const rpc = (server: Server, token: string, method: string, params?: unknown) =>
  req(server, "POST", "/mcp", { jsonrpc: "2.0", id: nextId++, method, params }, { authorization: `Bearer ${token}` });
async function tool(server: Server, token: string, name: string, args: unknown) {
  const res = await rpc(server, token, "tools/call", { name, arguments: args });
  assert.equal(res.status, 200, res.text);
  const r = res.json.result as { content: { text: string }[]; isError: boolean };
  return { isError: r.isError, text: r.content[0]!.text, data: r.isError ? undefined : JSON.parse(r.content[0]!.text) };
}

test("initialize, tools/list and tools/call round-trip; notifications and batches", async (t) => {
  const { server, newAgent } = await setup(t);
  const token = await newAgent("hermes");

  const init = await rpc(server, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.json.result.capabilities, { tools: {} });
  assert.equal(init.json.result.serverInfo.name, "t3-command-center");
  const unknownVersion = await rpc(server, token, "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknownVersion.json.result.protocolVersion, "2025-11-25");

  const note = await req(server, "POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, { authorization: `Bearer ${token}` });
  assert.equal(note.status, 202);
  assert.equal(note.text, "");

  const list = await rpc(server, token, "tools/list");
  assert.deepEqual(
    list.json.result.tools.map((x: { name: string }) => x.name),
    ["task_submit", "task_status", "task_list", "task_cancel", "machines_list"],
  );

  const call = await tool(server, token, "task_submit", { prompt: "Fix the build", project: "p-api" });
  assert.equal(call.isError, false);
  assert.equal(call.data.status, "pending_approval");

  const batch = await req(
    server,
    "POST",
    "/mcp",
    [
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", method: "notifications/cancelled" },
      { jsonrpc: "2.0", id: "b", method: "nope" },
    ],
    { authorization: `Bearer ${token}` },
  );
  assert.deepEqual(batch.json, [
    { jsonrpc: "2.0", id: "a", result: {} },
    { jsonrpc: "2.0", id: "b", error: { code: -32601, message: "Method not found: nope" } },
  ]);

  const unknownTool = await rpc(server, token, "tools/call", { name: "rm_rf", arguments: {} });
  assert.equal(unknownTool.json.error.code, -32602);
  assert.equal((await req(server, "GET", "/mcp")).status, 405);
});

test("bad, missing and revoked tokens get 401", async (t) => {
  const { server, cookie, newAgent } = await setup(t);
  assert.equal((await rpc(server, "cc_wrong", "ping")).status, 401);
  assert.equal((await req(server, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  const token = await newAgent("codex");
  assert.equal((await rpc(server, token, "ping")).status, 200);
  assert.equal((await req(server, "DELETE", "/api/agents/codex", undefined, { origin: PUBLIC, cookie })).status, 200);
  assert.equal((await rpc(server, token, "ping")).status, 401);
  // A foreign Origin never reaches the tool, even with a valid token.
  const other = await newAgent("claude");
  assert.equal((await req(server, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: `Bearer ${other}`, origin: "https://evil.example" })).status, 403);
});

test("task_submit always waits for approval and ignores runtimeMode, workspace and interactionMode", async (t) => {
  const { server, db, newAgent } = await setup(t);
  const token = await newAgent("hermes");
  const r = await tool(server, token, "task_submit", {
    prompt: "Deploy",
    project: "/srv/api",
    runtimeMode: "full-access",
    interactionMode: "plan",
    workspace: { type: "existing_worktree", worktreePath: "/etc" },
    status: "queued",
  });
  assert.equal(r.isError, false);
  const task = getTask(db, r.data.id)!;
  assert.equal(task.status, "pending_approval");
  assert.equal(task.runtimeMode, null);
  assert.equal(task.interactionMode, "default");
  assert.deepEqual(task.workspace, { type: "root" });
  assert.equal(task.source, "agent:hermes");
});

test("agent B cannot see, cancel or depend on agent A's task", async (t) => {
  const { server, db, newAgent } = await setup(t);
  const a = await newAgent("alpha");
  const b = await newAgent("beta");
  const { data } = await tool(server, a, "task_submit", { prompt: "A's work", project: "p-api" });

  assert.equal((await tool(server, a, "task_status", { id: data.id })).data.prompt, "A's work");
  assert.equal((await tool(server, a, "task_list", {})).data.length, 1);

  assert.deepEqual(await tool(server, b, "task_status", { id: data.id }), { isError: true, text: "Task not found", data: undefined });
  assert.deepEqual((await tool(server, b, "task_list", {})).data, []);
  assert.equal((await tool(server, b, "task_cancel", { id: data.id })).isError, true);
  assert.equal((await tool(server, b, "task_submit", { prompt: "x", project: "p-api", depends_on: [data.id] })).isError, true);
  assert.equal(getTask(db, data.id)!.status, "pending_approval");

  const cancelled = await tool(server, a, "task_cancel", { id: data.id });
  assert.equal(cancelled.data.status, "cancelled");
});

test("project resolution: id, deepest root, Windows paths, unique title, ambiguity", async (t) => {
  const { server, db, newAgent } = await setup(t);
  const token = await newAgent("hermes");
  const submit = async (args: Record<string, unknown>) => tool(server, token, "task_submit", { prompt: "x", ...args });

  assert.equal((await submit({ project: "/srv/app/web/src/main.ts" })).data.projectId, "p-web");
  assert.equal((await submit({ project: "/srv/app/lib" })).data.projectId, "p-app");
  assert.equal((await submit({ project: "/srv/application" })).isError, true); // a prefix, but not a path inside
  const win = await submit({ project: "c:/work/app/src/" });
  assert.deepEqual([win.data.machineId, win.data.projectId], ["m2", "p-pc"]);
  assert.equal((await submit({ project: "web" })).data.projectId, "p-web");

  const ambiguous = await submit({ project: "app" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /Ambiguous project "app".*on VPS.*on PC/);
  assert.equal((await submit({ project: "app", machine: "pc" })).data.projectId, "p-pc");
  assert.equal((await submit({ project: "nope" })).isError, true);

  const many = Array.from({ length: 8 }, (_, i) => project("m1", `d${i}`, "Dup", `/d${i}`));
  assert.throws(() => resolveProject(many, "dup", (id) => id), (e: Error) => e instanceof ToolError && (e.message.match(/id d\d/g) ?? []).length === 5);
  assert.equal(getTask(db, (await submit({ project: "p-web" })).data.id)!.projectId, "p-web");
});

test("oversized and malformed submissions are rejected", async (t) => {
  const { server, newAgent } = await setup(t);
  const token = await newAgent("hermes");
  const big = await tool(server, token, "task_submit", { prompt: "x".repeat(20_001), project: "p-api" });
  assert.equal(big.isError, true);
  assert.match(big.text, /prompt must be at most 20000/);
  assert.equal((await tool(server, token, "task_submit", { prompt: "  ", project: "p-api" })).isError, true);
  assert.equal((await tool(server, token, "task_submit", { prompt: "x", project: "p-api", priority: 9 })).isError, true);
  assert.equal((await tool(server, token, "task_submit", { prompt: "x", project: "p-api", model: "gpt" })).isError, true);
});

test("the token is shown once and never stored or listed", async (t) => {
  const { server, home, cookie, newAgent } = await setup(t);
  const token = await newAgent("hermes");
  assert.match(token, /^cc_[A-Za-z0-9_-]{43}$/);
  const dup = await req(server, "POST", "/api/agents", { label: "HERMES" }, { origin: PUBLIC, cookie });
  assert.equal(dup.status, 409);
  assert.equal((await req(server, "POST", "/api/agents", { label: "../x" }, { origin: PUBLIC, cookie })).status, 400);

  await rpc(server, token, "ping");
  const list = await req(server, "GET", "/api/agents", undefined, { cookie });
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].label, "hermes");
  assert.ok(list.json[0].lastUsedAt);
  assert.ok(!list.text.includes(token));
  assert.ok(!(await tool(server, token, "task_list", {})).text.includes(token));
  for (const f of readdirSync(home).filter((f) => f.startsWith("cc.sqlite"))) assert.ok(!readFileSync(join(home, f)).includes(token), f);
  // Cookie routes refuse cross-site callers.
  assert.equal((await req(server, "POST", "/api/agents", { label: "x" }, { origin: "https://evil.example", cookie })).status, 403);
  assert.equal((await req(server, "GET", "/api/agents")).status, 401);
});
