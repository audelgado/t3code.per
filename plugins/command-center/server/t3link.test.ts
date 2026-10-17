import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import {
  applyShellItem,
  checkContract,
  createLink,
  conversationMessages,
  emptyShell,
  T3_CONTRACT,
  threadLinks,
  type WsLike,
} from "./t3link.ts";
import { createInfra, FRESH_MS } from "./infra.ts";
import { T3Error, type LaunchInput, type LinkState, type Machine, type ShellUpdate } from "./types.ts";

const machine: Machine = {
  id: "env-1",
  label: "VPS",
  apiUrl: "https://vps.tail.ts.net",
  webUrl: "https://vps.tail.ts.net/",
  maxConcurrent: 2,
  enabled: true,
  serverVersion: null,
  tokenExpiresAt: null,
  createdAt: "2026-10-15T00:00:00.000Z",
};

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, any>[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  get subId() {
    return this.sent.find((m) => m.tag === "orchestration.subscribeShell")!.id;
  }
  chunk(...values: unknown[]) {
    this.recv({ _tag: "Chunk", requestId: this.subId, values });
  }
  requests(tag: string) {
    return this.sent.filter((m) => m._tag === "Request" && m.tag === tag);
  }
}

type Route = { status?: number; body?: unknown };
function fakeFetch(routes: Record<string, Route | (() => Route)>) {
  const calls: { method: string; path: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: URL, init: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init.method} ${u.pathname}`;
    calls.push({ method: String(init.method), path: u.pathname, headers: init.headers as Record<string, string> });
    const route = routes[key];
    const r = typeof route === "function" ? route() : (route ?? { status: 404 });
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const healthy = (protocol: number | undefined = 2) => ({
  "GET /.well-known/t3/environment": { body: { environmentId: "env-1", serverVersion: "0.9.0", orchestrationProtocolVersion: protocol } },
  "POST /api/auth/websocket-ticket": { body: { ticket: "tkt", expiresAt: "2026-10-15T00:05:00.000Z" } },
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function start(routes: Record<string, Route | (() => Route)> = healthy()) {
  const states: LinkState[] = [];
  const shells: ShellUpdate[] = [];
  const fetch = fakeFetch(routes);
  const link = createLink(
    machine,
    "secret-token",
    { onShell: (_, s) => shells.push(s), onState: (_, s) => states.push(s) },
    { WebSocketImpl: FakeWs, fetchImpl: fetch.impl },
  );
  return { link, states, shells, fetch };
}

async function online() {
  const ctx = start();
  await flush();
  const ws = FakeWs.all.at(-1)!;
  ws.open();
  ws.chunk(snapshot(5, [thread("t1"), thread("t2")]));
  return { ...ctx, ws };
}

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "p1",
  title: `Thread ${id}`,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5" },
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  hasActionableProposedPlan: false,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  settledAt: null,
  futureField: { ignored: true },
  ...extra,
});
const project = { id: "p1", title: "Repo", workspaceRoot: "/repo", defaultModelSelection: null, scripts: [], updatedAt: "x" };
const snapshot = (seq: number, threads: unknown[], extra: Record<string, unknown> = {}) => ({
  kind: "snapshot",
  snapshot: { schemaVersion: 1, snapshotSequence: seq, projects: [project], threads, archivedThreads: [] },
  ...extra,
});

beforeEach(() => {
  FakeWs.all = [];
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});
afterEach(() => mock.timers.reset());

test("connects with descriptor, ticket and protocol query, then subscribes", async () => {
  const { ws, fetch, states, link } = await online();
  assert.equal(ws.url, "wss://vps.tail.ts.net/ws?orchestrationProtocol=2&wsTicket=tkt");
  assert.equal(fetch.calls[1]!.headers.authorization, "Bearer secret-token");
  assert.deepEqual(ws.requests("orchestration.subscribeShell")[0]!.payload, {});
  assert.equal(link.state.status, "online");
  assert.equal(link.state.serverVersion, "0.9.0");
  assert.ok(!JSON.stringify(states).includes("secret-token"));
  link.close();
});

test("acks every chunk; authoritative snapshot then thread.updated gives correct rows", async () => {
  const { ws, shells, link } = await online();
  ws.chunk({ kind: "thread.updated", sequence: 6, location: "active", thread: thread("t1", { status: "running", activityRunStatus: "running", pendingRuntimeRequest: { id: "r1", kind: "command", createdAt: "c" }, usageLimitResetAt: "2026-10-16T00:00:00.000Z", limitRecovery: { runId: "x", resetAt: "y", autoResume: true }, lineage: { relationshipToParent: "subagent" } }) });
  assert.deepEqual(
    ws.sent.filter((m) => m._tag === "Ack").map((m) => m.requestId),
    [ws.subId, ws.subId],
  );
  assert.equal(shells[0]!.authoritative, true);
  assert.equal(shells[0]!.threads.length, 2);
  assert.equal(shells[0]!.projects[0]!.workspaceRoot, "/repo");
  const last = shells.at(-1)!;
  assert.equal(last.authoritative, false);
  const t1 = last.threads.find((t) => t.id === "t1")!;
  assert.equal(t1.machineId, "env-1");
  assert.equal(t1.status, "running");
  assert.deepEqual(t1.pendingRequest, { id: "r1", kind: "command", summary: null, createdAt: "c" });
  assert.equal(t1.usageLimitResetAt, "2026-10-16T00:00:00.000Z");
  assert.equal(t1.relationshipToParent, "subagent");
  assert.equal(t1.providerInstanceId, "codex");
  assert.ok(!("futureField" in t1));
  link.close();
});

test("enrichment snapshot with threads: [] keeps all threads and the sequence", () => {
  const state = emptyShell();
  const counters = { droppedRows: 0, unknownItems: 0 };
  applyShellItem("m", state, snapshot(5, [thread("t1"), thread("t2")]), counters);
  const r = applyShellItem("m", state, snapshot(9, [], { resolvedRepositoryIdentityRoots: ["/repo"] }), counters);
  assert.equal(r, null);
  assert.equal(state.threads.size, 2);
  assert.equal(state.sequence, 5);
});

test("stale deltas are ignored; archive location and thread.removed remove threads", () => {
  const state = emptyShell();
  const counters = { droppedRows: 0, unknownItems: 0 };
  assert.equal(applyShellItem("m", state, { kind: "thread.removed", sequence: 1, location: "active", threadId: "t1" }, counters), null, "delta before snapshot");
  applyShellItem("m", state, snapshot(5, [thread("t1"), thread("t2"), thread("t3")]), counters);
  assert.equal(applyShellItem("m", state, { kind: "thread.updated", sequence: 5, location: "active", thread: thread("t1", { title: "stale" }) }, counters), null);
  assert.equal(state.threads.get("t1")!.title, "Thread t1");
  assert.equal(applyShellItem("m", state, { kind: "thread.updated", sequence: 6, location: "archive", thread: thread("t1") }, counters), "delta");
  assert.equal(applyShellItem("m", state, { kind: "thread.removed", sequence: 7, location: "active", threadId: "t2" }, counters), "delta");
  assert.deepEqual([...state.threads.keys()], ["t3"]);
  assert.equal(state.sequence, 7);
  assert.equal(applyShellItem("m", state, { kind: "synchronized" }, counters), null);
  assert.deepEqual(counters, { droppedRows: 0, unknownItems: 0 });
});

test("unknown kinds are skipped and counted; rows missing id/status are dropped → degraded", async () => {
  const { ws, link, shells } = await online();
  ws.chunk({ kind: "thread.teleported", sequence: 6 }, { kind: "thread.updated", sequence: 7, location: "active", thread: { id: "t9" } });
  assert.equal(link.state.unknownItems, 1);
  assert.equal(link.state.droppedRows, 1);
  assert.equal(link.state.degraded, true);
  assert.equal(shells.at(-1)!.threads.length, 2);
  link.close();
});

test("launch never sends reuseExistingThread/creationSource; a retry resends identical ids", async () => {
  const { ws, link } = await online();
  const input: LaunchInput = {
    commandId: "cmd-1",
    threadId: "thr-1",
    projectId: "p1",
    title: "Fix bug",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    prompt: "Fix the bug",
  };
  const first = link.launch(input);
  const second = link.launch(input);
  const [a, b] = ws.requests("orchestration.launchThread");
  assert.ok(a && b);
  assert.deepEqual(a.payload, b.payload);
  assert.equal(a.payload.commandId, "cmd-1");
  assert.equal(a.payload.threadId, "thr-1");
  assert.equal(a.payload.generateTitle, false);
  assert.deepEqual(a.payload.initialMessage, { text: "Fix the bug", attachments: [] });
  assert.ok(!("reuseExistingThread" in a.payload) && !("creationSource" in a.payload));
  ws.recv({ _tag: "Exit", requestId: a.id, exit: { _tag: "Success", value: { threadId: "thr-1" } } });
  ws.recv({ _tag: "Exit", requestId: b.id, exit: { _tag: "Success", value: { threadId: "thr-1" } } });
  await Promise.all([first, second]);
  link.close();
});

test("questions and continued messages dispatch on the same thread with contract payloads", async () => {
  const { ws, link } = await online();
  const answer = link.answerInput!("t1", "q1", { where: ["vps:tayna"] });
  const message = link.sendMessage!("t1", "Continuar", "ced9f345-6071-4038-b77d-55a1e094d3d1");
  const [a, m] = ws.requests("orchestration.dispatchCommand");
  assert.equal(a!.payload.type, "runtime-request.respond");
  assert.deepEqual(a!.payload.answers, { where: ["vps:tayna"] });
  assert.equal(m!.payload.type, "message.dispatch");
  assert.equal(m!.payload.createdBy, "user");
  assert.equal(m!.payload.creationSource, "web");
  assert.equal(m!.payload.threadId, "t1");
  assert.equal(m!.payload.commandId, "ced9f345-6071-4038-b77d-55a1e094d3d1");
  assert.deepEqual(m!.payload.dispatchMode, { type: "start_immediately" });
  for (const r of [a!, m!]) ws.recv({ _tag: "Exit", requestId: r.id, exit: { _tag: "Success", value: {} } });
  await Promise.all([answer, message]);
  link.close();
});

test("Exit Failure rejects with T3Error; respond/interrupt/settle use fresh command ids", async () => {
  const { ws, link } = await online();
  const p = link.respond("t1", "r1", "accept");
  const req = ws.requests("orchestration.dispatchCommand")[0]!;
  assert.equal(req.payload.type, "runtime-request.respond");
  assert.equal(req.payload.decision, "accept");
  ws.recv({ _tag: "Exit", requestId: req.id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", message: "Request already resolved." } }] } });
  await assert.rejects(p, (e) => e instanceof T3Error && e.kind === "fail" && e.message === "Request already resolved.");
  const d = link.interrupt("t1", "run-1");
  const s = link.settle("t1");
  const [, i, st] = ws.requests("orchestration.dispatchCommand");
  assert.deepEqual([i!.payload.type, i!.payload.runId, st!.payload.type], ["run.interrupt", "run-1", "thread.settle"]);
  assert.notEqual(i!.payload.commandId, st!.payload.commandId);
  ws.recv({ _tag: "Exit", requestId: i!.id, exit: { _tag: "Failure", cause: [{ _tag: "Die", defect: "boom" }] } });
  await assert.rejects(d, (e) => e instanceof T3Error && e.kind === "die");
  link.close();
  await assert.rejects(s, (e) => !(e instanceof T3Error));
});

test("rpc times out after 30 s with a transport error and an Interrupt", async () => {
  const { ws, link } = await online();
  const p = link.settle("t1");
  for (let i = 0; i < 3; i++) {
    mock.timers.tick(10_000);
    ws.recv({ _tag: "Pong" });
  }
  await assert.rejects(p, (e) => !(e instanceof T3Error));
  assert.ok(ws.sent.some((m) => m._tag === "Interrupt"));
  link.close();
});

test("protocol 3 → incompatible, rechecked after 10 min", async () => {
  const { link, fetch } = start(healthy(3));
  await flush();
  assert.equal(link.state.status, "incompatible");
  assert.equal(FakeWs.all.length, 0);
  const calls = fetch.calls.length;
  mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(fetch.calls.length, calls + 1);
  link.close();
});

test("401 on the ticket → unauthorized and no retry", async () => {
  const { link, fetch } = start({ ...healthy(), "POST /api/auth/websocket-ticket": { status: 401 } });
  await flush();
  assert.equal(link.state.status, "unauthorized");
  const calls = fetch.calls.length;
  mock.timers.tick(60 * 60_000);
  await flush();
  assert.equal(fetch.calls.length, calls);
  link.close();
});

test("two missed Pongs reconnect and re-subscribe", async () => {
  const { ws, link } = await online();
  mock.timers.tick(10_000);
  ws.recv({ _tag: "Pong" });
  mock.timers.tick(10_000);
  mock.timers.tick(10_000);
  assert.equal(ws.closed, false);
  mock.timers.tick(10_000);
  assert.equal(ws.closed, true);
  assert.equal(link.state.status, "offline");
  mock.timers.tick(5 * 60_000);
  await flush();
  const next = FakeWs.all.at(-1)!;
  assert.notEqual(next, ws);
  next.open();
  assert.equal(next.requests("orchestration.subscribeShell").length, 1);
  next.chunk(snapshot(1, [thread("t1")]));
  assert.equal(link.state.status, "online");
  link.close();
});

test("conversation history keeps both speakers in order and bounds message and total payload", () => {
  const messages = conversationMessages([{ id: "2", role: "assistant", text: "Hola", createdAt: "b" }, { id: "1", role: "user", text: "Pedido", createdAt: "a" }, { id: "system", role: "system", text: "hidden", createdAt: "c" }]);
  assert.deepEqual(messages.map((m) => m.id), ["1", "2"]);
  const large = conversationMessages(Array.from({ length: 100 }, (_, i) => ({ id: String(i), role: "assistant", text: "x".repeat(30000), createdAt: String(i).padStart(3, "0") })));
  assert.ok(large.length <= 80);
  assert.ok(large.reduce((n, m) => n + m.text.length, 0) <= 120000);
  assert.equal(large.at(-1)!.id, "99");
});

test("readResult takes the last assistant text and pending request details", async () => {
  const projection = {
    messages: [
      { role: "assistant", text: "older", createdAt: "2026-10-15T00:00:01.000Z" },
      { role: "assistant", text: "x".repeat(13000), createdAt: "2026-10-15T00:00:03.000Z" },
      { role: "user", text: "later user", createdAt: "2026-10-15T00:00:04.000Z" },
    ],
    runtimeRequests: [
      { id: "r0", kind: "command", status: "resolved", createdAt: "a" },
      { id: "r1", kind: "command", status: "pending", createdAt: "b" },
    ],
    turnItems: [{ type: "approval_request", requestId: "r1", requestKind: "command", prompt: "rm -rf build" }],
  };
  const { link, fetch } = start({ ...healthy(), "GET /api/orchestration/threads/t1/bounded": { body: { snapshotSequence: 3, projection } } });
  await flush();
  const result = await link.readResult("t1");
  assert.equal(result.text!.length, 12000);
  assert.deepEqual(result.pending, { id: "r1", kind: "command", summary: "rm -rf build", createdAt: "b" });
  assert.equal(fetch.calls.at(-1)!.headers["x-t3-orchestration-protocol"], "2");
  link.close();
});

test("bounded user-input questions preserve IDs, option values and editable answer settings", async () => {
  const question = { id: "q1", header: "Destino", question: "¿Dónde seguimos?", options: [{ label: "VPS", description: "Remoto", value: "tayna" }], multiSelect: true, allowCustomAnswer: false, required: false, initialAnswer: "" };
  const projection = { messages: [], runtimeRequests: [{ id: "r1", kind: "user_input", status: "pending", createdAt: "b" }], visibleTurnItems: [{ item: { type: "user_input_request", requestId: "r1", questions: [question] } }] };
  const { link } = start({ ...healthy(), "GET /api/orchestration/threads/t1/bounded": { body: { projection } } });
  assert.deepEqual((await link.readResult("t1")).pending?.questions, [question]);
  link.close();
});

test("session uses effective granular permissions and respects an explicitly empty grant", async () => {
  for (const permissions of [["orchestration:read", "filesystem:read"], []]) {
    const { link } = start({ ...healthy(), "GET /api/auth/session": { body: { authenticated: true, scopes: ["orchestration:read"], permissions } } });
    assert.deepEqual((await link.session()).scopes, permissions);
    link.close();
  }
});

test("session() returns expiry and scopes", async () => {
  const { link } = start({ ...healthy(), "GET /api/auth/session": { body: { authenticated: true, scopes: ["orchestration:read"], expiresAt: "2027-01-01T00:00:00.000Z" } } });
  await flush();
  assert.deepEqual(await link.session(), { expiresAt: "2027-01-01T00:00:00.000Z", scopes: ["orchestration:read"] });
  link.close();
});

test("hostResources() calls server.getHostResources and maps the snapshot", async () => {
  const { ws, link } = await online();
  const p = link.hostResources();
  const req = ws.requests("server.getHostResources")[0]!;
  assert.deepEqual(req.payload, {});
  const value = { sampledAt: Date.parse("2026-10-15T00:00:00.000Z"), cpuUtilization: 0.25, cpuCount: 8, availableMemoryBytes: 4, totalMemoryBytes: 16, disks: [] };
  ws.recv({ _tag: "Exit", requestId: req.id, exit: { _tag: "Success", value } });
  assert.deepEqual(await p, {
    sampledAt: "2026-10-15T00:00:00.000Z",
    cpuUtilization: 0.25,
    cpuCount: 8,
    availableMemoryBytes: 4,
    totalMemoryBytes: 16,
  });
  link.close();
});

test("shell rows carry branch, worktree and the PR on that branch", async () => {
  const link = (number: number, headBranch: string, extra: Record<string, unknown> = {}) => ({
    host: "github.com",
    repository: "o/r",
    number,
    url: `https://x/${number}`,
    source: "created",
    linkedAt: "2026-10-01T00:00:00Z",
    stack: null,
    snapshot: { state: "merged", title: "t", headBranch, baseBranch: "main", isDraft: false, updatedAt: null, syncedAt: `2026-10-0${number}T00:00:00Z` },
    ...extra,
  });
  const { ws, shells, link: l } = await online();
  ws.chunk(
    snapshot(6, [
      thread("t1", { branch: "feat", worktreePath: "/wt", pullRequests: [link(1, "feat"), link(2, "feat"), link(3, "other"), link(4, "feat", { source: "stack-dismissed" })] }),
      thread("t2", { branch: "feat", branchPullRequest: { projectId: "p1", repository: "o/r", number: 9, url: "https://x/9" } }),
      thread("t3"),
    ]),
  );
  const rows = shells.at(-1)!.threads as any[];
  assert.deepEqual([rows[0].branch, rows[0].worktreePath, rows[0].pr], ["feat", "/wt", { number: 2, url: "https://x/2", state: "merged", isDraft: false }]);
  assert.deepEqual(rows[1].pr, { number: 9, url: "https://x/9", state: null, isDraft: false });
  assert.deepEqual([rows[2].branch, rows[2].worktreePath, rows[2].pr], [null, null, null]);
  l.close();
});

test("vcsStatus() reads the first stream value passively, then interrupts", async () => {
  const { ws, link } = await online();
  const p = link.vcsStatus("/wt");
  const req = ws.requests("subscribeVcsStatus")[0]!;
  assert.deepEqual(req.payload, { cwd: "/wt", includeRemote: false });
  const local = { isRepo: true, hasPrimaryRemote: true, isDefaultRef: false, refName: "feat", hasWorkingTreeChanges: true, workingTree: { files: [{ path: "a" }, { path: "b" }], insertions: 1, deletions: 0 } };
  const remote = { hasUpstream: true, aheadCount: 2, behindCount: 1, pr: { number: 4, title: "t", url: "https://x/4", baseRef: "main", headRef: "feat", state: "open", isDraft: true } };
  ws.recv({ _tag: "Chunk", requestId: req.id, values: [{ _tag: "snapshot", local, remote }] });
  assert.deepEqual(await p, {
    refName: "feat",
    isDefaultRef: false,
    hasPrimaryRemote: true,
    changedFiles: 2,
    remote: { hasUpstream: true, aheadCount: 2, behindCount: 1, aheadOfDefaultCount: null, pr: { number: 4, url: "https://x/4", state: "open", isDraft: true } },
  });
  assert.ok(ws.sent.some((m) => m._tag === "Interrupt" && m.requestId === req.id));
  // Not a repository.
  const q = link.vcsStatus("/tmp");
  const req2 = ws.requests("subscribeVcsStatus")[1]!;
  ws.recv({ _tag: "Chunk", requestId: req2.id, values: [{ _tag: "snapshot", local: { ...local, isRepo: false }, remote: null }] });
  assert.equal(await q, null);
  link.close();
});

test("mergedPullRequests() lists merged PRs of the given projects", async () => {
  const { ws, link } = await online();
  const p = link.mergedPullRequests(["p1"]);
  const req = ws.requests("pullRequests.list")[0]!;
  assert.deepEqual(req.payload, { state: "merged", projectIds: ["p1"], limit: 50 });
  const entry = { projectId: "p1", headBranch: "feat", number: 3, url: "https://x/3", state: "merged", title: "t" };
  ws.recv({ _tag: "Exit", requestId: req.id, exit: { _tag: "Success", value: { entries: [entry, { ...entry, state: "open" }, { number: 1 }], errors: [] } } });
  assert.deepEqual(await p, [{ projectId: "p1", headBranch: "feat", number: 3, url: "https://x/3" }]);
  link.close();
});

test("listEntries() and readFile() call the project RPCs and map their results", async () => {
  const { ws, link } = await online();
  const p = link.listEntries("/repo", ".t3/workflows");
  const req = ws.requests("projects.listEntries")[0]!;
  assert.deepEqual(req.payload, { cwd: "/repo", directoryPath: ".t3/workflows" });
  const entries = [{ path: ".t3/workflows/a.json", kind: "file" }, { path: ".t3/workflows/snippets", kind: "directory" }, { path: "x", kind: "link" }, { kind: "file" }];
  ws.recv({ _tag: "Exit", requestId: req.id, exit: { _tag: "Success", value: { entries, truncated: false } } });
  assert.deepEqual(await p, entries.slice(0, 2));
  const q = link.readFile("/repo", ".t3/workflows/a.json");
  const req2 = ws.requests("projects.readFile")[0]!;
  assert.deepEqual(req2.payload, { cwd: "/repo", relativePath: ".t3/workflows/a.json" });
  ws.recv({ _tag: "Exit", requestId: req2.id, exit: { _tag: "Success", value: { relativePath: ".t3/workflows/a.json", contents: "{}", byteLength: 2, truncated: false } } });
  assert.deepEqual(await q, { contents: "{}", truncated: false });
  link.close();
});

test("infra reads hostResources only for online machines, at most once per 30 s", async () => {
  let clock = 0;
  let calls = 0;
  const res = { sampledAt: "x", cpuUtilization: 0.5, cpuCount: 2, availableMemoryBytes: 1, totalMemoryBytes: 2 };
  const state = (status: LinkState["status"]) => ({ status }) as LinkState;
  const links: Record<string, any> = {
    a: { state: state("online"), hostResources: async () => (calls++, res) },
    b: { state: state("offline"), hostResources: async () => (calls++, res) },
    c: { state: state("online") }, // a link without the method
  };
  const view = (id: string) => ({ ...machine, id, link: links[id].state, running: 0, queued: 0 });
  const infra = createInfra({ machines: () => ["a", "b", "c"].map(view), link: (id) => links[id], now: () => clock });
  const first = await infra.read();
  assert.deepEqual(first.map((m) => [m.resources, m.resourcesError]), [[res, null], [null, null], [null, "Not supported by this link."]]);
  await infra.read();
  assert.equal(calls, 1);
  clock += FRESH_MS;
  await infra.read();
  assert.equal(calls, 2);
});

test("thread deep links", () => {
  assert.deepEqual(threadLinks(machine, "t 1"), {
    appUrl: "t3code://threads/env-1/t%201",
    webUrl: "https://vps.tail.ts.net/env-1/t%201",
  });
  assert.equal(threadLinks({ ...machine, webUrl: null }, "t").webUrl, null);
});

test("checkContract reports missing files and changed needles", async () => {
  const misses = await checkContract(async () => null);
  assert.equal(misses.length, T3_CONTRACT.length);
  const first = T3_CONTRACT[0]!;
  const one = await checkContract(async (f) => (f === first.file ? first.needle.replace(/ +/g, "\n  ") : null));
  assert.ok(!one.includes(first));
});

const repoRoot = join(import.meta.dirname, "../../..");
test("contract holds against the enclosing T3 checkout", { skip: !existsSync(join(repoRoot, "packages/contracts/src/orchestrationV2.ts")) }, async () => {
  const misses = await checkContract(async (f) => (existsSync(join(repoRoot, f)) ? readFileSync(join(repoRoot, f), "utf8") : null));
  assert.deepEqual(misses, []);
});

// Fixtures recorded by `contract-check --record` (P1-9): one JSON line per frame, either the raw
// frame or {direction, data}. Inbound shell chunks must replay through the reducer without loss.
const fixtureDir = join(import.meta.dirname, "fixtures");
const fixtures = existsSync(fixtureDir) ? readdirSync(fixtureDir).filter((f) => f.endsWith(".jsonl")) : [];
test("recorded fixtures replay through the reducer", { skip: fixtures.length === 0 }, () => {
  for (const file of fixtures) {
    const state = emptyShell();
    const counters = { droppedRows: 0, unknownItems: 0 };
    let authoritative = 0;
    for (const line of readFileSync(join(fixtureDir, file), "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.direction === "out") continue;
      const raw = entry.frame ?? entry.data;
      const frame = typeof raw === "string" ? JSON.parse(raw) : entry;
      for (const m of Array.isArray(frame) ? frame : [frame]) {
        if (m._tag !== "Chunk") continue;
        for (const v of m.values) if (applyShellItem("m", state, v, counters) === "authoritative") authoritative++;
      }
    }
    assert.deepEqual(counters, { droppedRows: 0, unknownItems: 0 }, file);
    if (file.startsWith("shell")) assert.ok(authoritative > 0, `${file} has an authoritative snapshot`);
  }
});
