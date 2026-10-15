import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "./http.ts";
import { cliFile, createOrca, MAX_ROWS, OrcaError, processRunner, project, type OrcaRunner } from "./orca.ts";

// Recorded shapes from Orca 1.4.224 (`status`, `worktree ps`, `terminal list`), trimmed and with paths and names redacted.
const STATUS = { id: "s", ok: true, result: { target: { kind: "local" }, app: { running: true, pid: 1, desktopWindowStatus: "available" }, runtime: { state: "ready", reachable: true, connectionState: "connected", appVersion: "1.4.224", capabilities: ["runtime.environments.v1"] }, graph: { state: "ready" } }, _meta: { runtimeId: "r" } };
const STOPPED = { id: "s", ok: true, result: { target: { kind: "local" }, app: { running: false }, runtime: { state: "not-running", reachable: false } } };
const wt = (patch: Record<string, unknown>) => ({
  workspaceKind: "git",
  worktreeId: "repo-a::C:/work/app",
  repoId: "repo-a",
  hostId: "local",
  terminalPlatform: "win32",
  repo: "app",
  path: "C:/work/app",
  branch: "refs/heads/main",
  isArchived: false,
  isMainWorktree: true,
  displayName: "app",
  workspaceStatus: "in-progress",
  lastActivityAt: 1792040575427,
  comment: "",
  isPinned: false,
  unread: false,
  liveTerminalCount: 2,
  hasAttachedPty: true,
  lastOutputAt: 1792040675137,
  preview: "/\n8",
  status: "working",
  agents: [],
  terminalVerdict: "live",
  ...patch,
});
const PS = {
  id: "p",
  ok: true,
  result: {
    worktrees: [
      wt({}),
      wt({ worktreeId: "repo-a::C:/orca/app/fix", path: "C:/orca/app/fix", branch: "refs/heads/user/fix", isMainWorktree: false, displayName: "fix", status: "active", liveTerminalCount: 1, unread: true, lastOutputAt: 1791998930329, preview: `Worked for 3m 1s ${"x".repeat(400)} • 12:28` }),
      wt({ workspaceKind: "folder-workspace", worktreeId: "folder:f1", repoId: "folder-workspace:f1", hostId: undefined, repo: "Group", path: "E:/group", branch: "", isMainWorktree: false, displayName: "Group workspace", status: "inactive", liveTerminalCount: 0, terminalVerdict: "none", lastOutputAt: null, preview: "" }),
      wt({ worktreeId: "repo-b::/home/user", repoId: "repo-b", hostId: "ssh:ssh-1", terminalPlatform: "linux", repo: "server", path: "/home/user", branch: "", status: "inactive", liveTerminalCount: 0, terminalVerdict: "unverifiable", lastOutputAt: null, preview: "" }),
    ],
    hostScope: { hostIds: ["local", "ssh:ssh-1"], omittedHostIds: [] },
    totalCount: 4,
    truncated: false,
  },
};
const term = (patch: Record<string, unknown>) => ({
  handle: "term_c89ea081-65a8-43ca-aa5d-14ce4aef8321",
  ptyId: "repo-a::C:/work/app@@1653b420",
  incarnationId: "i",
  orphaned: false,
  worktreeId: "repo-a::C:/work/app",
  worktreePath: "C:/work/app",
  branch: "refs/heads/main",
  tabId: "t",
  leafId: "l",
  title: "◐ Build the thing",
  connected: true,
  writable: true,
  lastOutputAt: 1792040676029,
  preview: "/\nq",
  executionHostId: "local",
  agentIdentity: "claude",
  ...patch,
});
const TL = {
  id: "t",
  ok: true,
  result: {
    terminals: [
      term({}),
      term({ handle: "term_shell", title: "PowerShell", agentIdentity: undefined, lastOutputAt: 1792036202996, preview: "PS C:\\work\\app> " }),
      term({ handle: "term_codex", worktreeId: "repo-a::C:/orca/app/fix", worktreePath: "C:/orca/app/fix", title: "Fix | fix", agentIdentity: "codex", lastOutputAt: 1791998930329 }),
      term({ handle: "term_stray", worktreeId: "repo-c::C:/other", worktreePath: "C:/other", lastOutputAt: 1700000000000 }),
      term({ handle: "term_gone", orphaned: true }),
    ],
    hostScope: { hostIds: ["local"], omittedHostIds: [] },
    totalCount: 5,
    truncated: false,
  },
};

/** Answers by the first two args; records every call. */
function fake(answers: Record<string, unknown>) {
  const calls: string[][] = [];
  const run: OrcaRunner = async (args) => {
    calls.push(args);
    const key = args[0] === "status" ? "status" : `${args[0]} ${args[1]}`;
    const a = answers[key];
    if (a instanceof Error) throw a;
    if (a === "timeout") return { code: null, stdout: "", timedOut: true };
    return { code: 0, stdout: typeof a === "string" ? a : JSON.stringify(a ?? { ok: false, error: { code: "unknown" } }), timedOut: false };
  };
  return { run, calls };
}
const orca = (answers: Record<string, unknown>, environment?: string) => {
  const f = fake({ status: STATUS, ...answers });
  return { ...createOrca({ cli: "orca", environment, run: f.run }), calls: f.calls };
};

test("off unless CC_ORCA_CLI is set: no CLI call, actions refuse", async () => {
  const f = fake({});
  const o = createOrca({ run: f.run });
  const l = await o.list();
  assert.equal(l.configured, false);
  assert.deepEqual(l.worktrees, []);
  await assert.rejects(o.send("term_x", { text: "hi" }), (e: OrcaError) => e.code === "off");
  assert.equal(f.calls.length, 0);
});

test("list projects ps + terminal list to live worktrees with their terminals", async () => {
  const o = orca({ "worktree ps": PS, "terminal list": TL });
  const l = await o.list();
  assert.equal(l.running, true);
  assert.equal(l.version, "1.4.224");
  assert.deepEqual(o.calls.map((c) => c.slice(0, 2).join(" ")), ["status --json", "worktree ps", "terminal list"]);
  assert.deepEqual(l.worktrees.map((w) => w.name), ["app", "fix", "other"]); // inactive rows dropped, stray terminal kept
  const [app, fix] = l.worktrees;
  assert.equal(app!.branch, "main");
  assert.deepEqual(app!.terminals.map((t) => [t.handle, t.agent]), [["term_c89ea081-65a8-43ca-aa5d-14ce4aef8321", "claude"], ["term_shell", null]]);
  assert.equal(fix!.unread, true);
  assert.ok(fix!.preview.length <= 160 && fix!.preview.endsWith("• 12:28"));
  assert.equal(app!.terminals[0]!.preview, "/ q");
  assert.ok(!JSON.stringify(l).includes("term_gone"));
  // Main worktrees and folders on the runtime's own host; never SSH hosts.
  assert.deepEqual(l.repos, [{ name: "app", path: "C:/work/app" }, { name: "Group workspace", path: "E:/group" }]);
});

test("list caps worktrees at 50 and is single-flight", async () => {
  const many = { ok: true, result: { worktrees: Array.from({ length: 80 }, (_, i) => wt({ worktreeId: `r::${i}`, lastOutputAt: i })) } };
  const o = orca({ "worktree ps": many, "terminal list": { ok: true, result: { terminals: [] } } });
  const [a, b] = await Promise.all([o.list(), o.list()]);
  assert.equal(a, b);
  assert.equal(a.worktrees.length, MAX_ROWS);
  assert.equal(a.worktrees[0]!.id, "r::79");
  assert.equal(o.calls.length, 3);
});

test("not running: list stops after status and actions refuse without starting Orca", async () => {
  const o = orca({ status: STOPPED });
  const l = await o.list();
  assert.equal(l.running, false);
  assert.match(l.message!, /not running/);
  await assert.rejects(o.launch({ projectPath: "C:/work/app", agent: "codex", name: "t", prompt: "go" }), (e: OrcaError) => e.code === "not_running");
  assert.deepEqual(o.calls.map((c) => c[0]), ["status", "status"]);
});

test("launch: one worktree create with an args array, --environment appended", async () => {
  const o = orca({ "worktree create": { ok: true, result: { worktree: { id: "repo-a::C:/orca/app/t" }, agentTerminalHandle: "term_new" } } }, "env-pc");
  const r = await o.launch({ projectPath: "C:/work/app", agent: "codex", name: "fix-login", prompt: "--not a flag\nline 2" });
  assert.deepEqual(r, { worktreeId: "repo-a::C:/orca/app/t", handle: "term_new" });
  assert.deepEqual(o.calls[0], ["status", "--json", "--environment=env-pc"]);
  assert.deepEqual(o.calls[1], [
    "worktree",
    "create",
    "--repo=path:C:/work/app",
    "--name=fix-login",
    "--no-parent",
    "--agent=codex",
    "--prompt=--not a flag\nline 2",
    "--json",
    "--environment=env-pc",
  ]);
  const old = orca({ "worktree create": { ok: true, result: { worktree: { id: "w" }, startupTerminal: { handle: "term_old" } } } });
  assert.equal((await old.launch({ projectPath: "/srv/app", agent: "claude", name: "t", prompt: "p" })).handle, "term_old");
});

test("launch validates before calling Orca", async () => {
  const o = orca({});
  const ok = { projectPath: "C:/work/app", agent: "codex", name: "t", prompt: "go" };
  for (const bad of [{ projectPath: "work/app" }, { agent: "grok" }, { name: "-x" }, { name: "a b" }, { prompt: " " }])
    await assert.rejects(o.launch({ ...ok, ...bad }), (e: OrcaError) => e.code === "invalid");
  assert.equal(o.calls.length, 0);
});

test("read: screen text, stale handles map to re-list", async () => {
  const o = orca({ "terminal read": { ok: true, result: { terminal: { handle: "term_a" }, source: "screen", tail: ["line 1", "line 2"] } } });
  assert.deepEqual(await o.read("term_a"), { handle: "term_a", source: "screen", text: "line 1\nline 2" });
  assert.deepEqual(o.calls[1], ["terminal", "read", "--terminal=term_a", "--screen", "--json"]);
  const stale = orca({ "terminal read": { ok: false, error: { code: "terminal_handle_stale", message: "x" } } });
  await assert.rejects(stale.read("term_a"), (e: OrcaError) => e.code === "stale" && /re-list/.test(e.message));
  await assert.rejects(o.read("term a;rm"), (e: OrcaError) => e.code === "invalid");
});

test("send: text with Enter or interrupt, and a timeout is never retried", async () => {
  const o = orca({ "terminal send": { ok: true, result: { send: { accepted: true, requestId: "q" } } } });
  assert.deepEqual(await o.send("term_a", { text: "continue" }), { accepted: true });
  assert.deepEqual(o.calls[1], ["terminal", "send", "--terminal=term_a", "--text=continue", "--enter", "--json"]);
  await o.send("term_a", { interrupt: true });
  assert.deepEqual(o.calls[3], ["terminal", "send", "--terminal=term_a", "--interrupt", "--json"]);
  await assert.rejects(o.send("term_a", {}), (e: OrcaError) => e.code === "invalid");

  const slow = orca({ "terminal send": "timeout" });
  await assert.rejects(slow.send("term_a", { text: "go" }), (e: OrcaError) => e.code === "timeout" && /before sending again/.test(e.message));
  assert.equal(slow.calls.filter((c) => c[1] === "send").length, 1);
});

test("lenient envelope: garbage output fails cleanly; routes are cookie-only and map errors", async () => {
  const o = orca({ "terminal read": "not json" });
  await assert.rejects(o.read("term_a"), (e: OrcaError) => e.code === "failed" && /exit 0/.test(e.message));
  assert.deepEqual(o.routes.map((r) => `${r.method} ${r.path} ${r.auth}`), [
    "GET /api/orca cookie",
    "POST /api/orca/launch cookie",
    "GET /api/orca/:handle cookie",
    "POST /api/orca/:handle/send cookie",
  ]);
  const read = o.routes[2]!;
  await assert.rejects(Promise.resolve(read.handler({ params: { handle: "term_a" } } as never)), (e: HttpError) => e.status === 502 && e.code === "orca_error");
});

test("project tolerates missing fields", () => {
  assert.deepEqual(project({}, {}), { worktrees: [], repos: [] });
  assert.equal(project({ worktrees: [{ worktreeId: "w", status: "working" }] }, {}).worktrees[0]!.name, "w");
});

test("cliFile spawns the .exe on Windows", () => {
  assert.equal(cliFile("C:/orca/bin/orca.cmd", "win32"), "C:/orca/bin/orca.exe");
  assert.equal(cliFile("/opt/orca/orca", "linux"), "/opt/orca/orca");
});

test("processRunner: args array without a shell, output cap and timeout", async () => {
  const node = process.execPath;
  const echo = await processRunner(node)(["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "a b", "--x=$(y)\n"]);
  assert.deepEqual(JSON.parse(echo.stdout), ["a b", "--x=$(y)\n"]);
  await assert.rejects(processRunner(node, 5_000, 100)(["-e", "process.stdout.write('x'.repeat(10000))"]), /too much output/);
  const slow = await processRunner(node, 200)(["-e", "setTimeout(() => {}, 10000)"]);
  assert.equal(slow.timedOut, true);
  await assert.rejects(processRunner(`${node}-missing`)([]), /not found/);
});
