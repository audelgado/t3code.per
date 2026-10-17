import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getTask, openDb, replaceProjects, upsertMachine } from "./db.ts";
import { Dispatcher, TaskError } from "./dispatcher.ts";
import { T3Error, type LaunchInput, type LinkState, type ProjectRow, type ProviderInfo, type T3Link, type TaskInput, type ThreadRow } from "./types.ts";

const T0 = Date.parse("2026-10-15T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function fakeLink(machineId: string) {
  const link = {
    machineId,
    state: { status: "online", since: iso(T0), degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: "1.0.0", message: null } as LinkState,
    launches: [] as LaunchInput[],
    interrupts: [] as [string, string][],
    launchError: null as Error | null,
    providerList: [
      { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: true, installed: true, models: [{ slug: "gpt-5", name: "GPT-5", isDefault: true }] },
    ] as ProviderInfo[],
    results: new Map<string, string>(),
    async launch(input: LaunchInput) {
      link.launches.push(input);
      if (link.launchError) throw link.launchError;
    },
    async interrupt(threadId: string, runId: string) {
      link.interrupts.push([threadId, runId]);
    },
    async respond() {},
    async settle() {},
    async providers() {
      return link.providerList;
    },
    async readResult(threadId: string) {
      return { text: link.results.get(threadId) ?? null, pending: null };
    },
    async session() {
      return { expiresAt: null, scopes: [] };
    },
    close() {},
  };
  return link satisfies T3Link;
}

function setup(t: { after(fn: () => void): void }, maxConcurrent = 2) {
  const home = mkdtempSync(join(tmpdir(), "cc-disp-"));
  const db = openDb(home);
  const clock = { now: T0 };
  const projects: ProjectRow[] = ["p1", "p2"].map((id) => ({
    machineId: "m1",
    id,
    title: id.toUpperCase(),
    workspaceRoot: `/srv/${id}`,
    defaultModel: null,
    updatedAt: iso(T0),
  }));
  upsertMachine(db, { id: "m1", label: "VPS", apiUrl: "https://vps", webUrl: null, maxConcurrent, enabled: true, serverVersion: null, tokenExpiresAt: null, createdAt: iso(T0) });
  replaceProjects(db, "m1", projects);
  const link = fakeLink("m1");
  let n = 0;
  const make = () => new Dispatcher({ db, link: (id) => (id === "m1" ? link : undefined), now: () => clock.now, newId: () => `id${++n}` });
  const d = make();
  t.after(() => {
    d.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const add = (input: Partial<TaskInput> = {}, source: "user" | `agent:${string}` = "user") => {
    clock.now += 1; // distinct createdAt for FIFO
    return d.createTask({ prompt: "do it", machineId: "m1", projectId: "p1", workspace: { type: "worktree", baseRef: "main" }, ...input }, source);
  };
  const task = (id: string) => getTask(db, id)!;
  const row = (taskId: string, patch: Partial<ThreadRow> = {}): ThreadRow => ({
    machineId: "m1",
    id: task(taskId).threadId!,
    projectId: task(taskId).projectId,
    title: "t",
    status: "running",
    activityRunStatus: "running",
    activeRunId: `run-${taskId}`,
    pendingRequest: null,
    hasActionableProposedPlan: false,
    lastError: null,
    usageLimitResetAt: null,
    relationshipToParent: null,
    snoozedUntil: null,
    settledAt: null,
    providerInstanceId: "codex",
    completedAt: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...patch,
  });
  /** One authoritative shell frame, then let the dispatcher settle. */
  const shell = async (threads: ThreadRow[], dispatcher = d) => {
    await dispatcher.onShell("m1", { projects, threads, authoritative: true });
    await dispatcher.dispatch();
  };
  const launchedIds = () => link.launches.map((l) => l.threadId);
  return { db, d, make, clock, link, add, task, row, shell, launchedIds };
}

test("a newer T3 continuation recovers a cancelled step and releases its chain without relaunching it", async (t) => {
  const s = setup(t);
  const a = s.add();
  const b = s.add({ dependsOn: [a.id] });
  await s.d.dispatch();
  await s.shell([s.row(a.id, { status: "cancelled", activeRunId: null })]);
  assert.equal(s.task(a.id).status, "cancelled");
  assert.equal(s.task(b.id).status, "queued");
  const launches = s.link.launches.length;
  s.clock.now += 1000;
  s.link.results.set(s.task(a.id).threadId!, "Recovered result");
  await s.shell([s.row(a.id, { status: "completed", activeRunId: null, updatedAt: iso(s.clock.now) })]);
  assert.equal(s.task(a.id).status, "done");
  assert.equal(s.task(a.id).error, null);
  assert.equal(s.task(b.id).status, "starting");
  assert.equal(s.link.launches.length, launches + 1);
  assert.match(s.link.launches.at(-1)!.prompt, /Recovered result/);
});

test("a local cancellation stays final even if T3 later completes the thread", async (t) => {
  const s = setup(t);
  const a = s.add();
  await s.d.dispatch();
  await s.d.cancel(a.id);
  s.clock.now += 1000;
  await s.shell([s.row(a.id, { status: "completed", activeRunId: null, updatedAt: iso(s.clock.now) })]);
  assert.equal(s.task(a.id).status, "cancelled");
});

test("an old completed snapshot cannot undo a newer T3 cancellation", async (t) => {
  const s = setup(t);
  const a = s.add();
  await s.d.dispatch();
  s.clock.now += 1000;
  await s.shell([s.row(a.id, { status: "cancelled", activeRunId: null, updatedAt: iso(s.clock.now) })]);
  await s.shell([s.row(a.id, { status: "completed", activeRunId: null, updatedAt: iso(T0) })]);
  assert.equal(s.task(a.id).status, "cancelled");
});

test("priority first, then FIFO; title from the first line", async (t) => {
  const s = setup(t, 3);
  s.link.state = { ...s.link.state, status: "offline" };
  const a = s.add({ prompt: "first\nmore" });
  const b = s.add({ priority: 2 });
  const c = s.add();
  s.link.state = { ...s.link.state, status: "online" };
  s.d.onState("m1", s.link.state);
  await s.d.dispatch();
  assert.deepEqual(s.link.launches.map((l) => l.threadId), [b, a, c].map((x) => s.task(x.id).threadId));
  assert.equal(a.title, "first");
  assert.equal(s.link.launches[1]!.title, "first");
  assert.equal(s.link.launches[1]!.runtimeMode, "full-access");
  assert.deepEqual(s.link.launches[1]!.modelSelection, { instanceId: "codex", model: "gpt-5" });
});

test("per-machine cap; waiting does not count", async (t) => {
  const s = setup(t, 2);
  // c uses another provider: b's usage limit pauses codex.
  const [a, b, c] = [s.add(), s.add(), s.add({ model: { instanceId: "claude", model: "opus" } })];
  await s.d.dispatch();
  assert.deepEqual([a, b, c].map((x) => s.task(x.id).status), ["starting", "starting", "queued"]);
  await s.shell([s.row(a.id), s.row(b.id, { status: "failed", activeRunId: null, usageLimitResetAt: iso(T0 + 3_600_000) })]);
  assert.equal(s.task(b.id).status, "waiting");
  assert.equal(s.task(c.id).status, "starting");
});

test("a second root task on the same project waits; worktree tasks run beside it", async (t) => {
  const s = setup(t, 5);
  const root1 = s.add({ workspace: { type: "root" } });
  const wt = s.add();
  const root2 = s.add({ workspace: { type: "root" } });
  const otherProject = s.add({ workspace: { type: "root" }, projectId: "p2" });
  await s.d.dispatch();
  assert.deepEqual([root1, wt, root2, otherProject].map((x) => s.task(x.id).status), ["starting", "starting", "queued", "starting"]);
  await s.shell([s.row(root1.id, { status: "completed" }), s.row(wt.id), s.row(otherProject.id)]);
  assert.equal(s.task(root1.id).status, "done");
  assert.equal(s.task(root2.id).status, "starting");
});

test("dependencies gate dispatch and their results reach the prompt", async (t) => {
  const s = setup(t, 3);
  const a = s.add({ title: "Research" });
  const b = s.add({ prompt: "use it", dependsOn: [a.id] });
  const failing = s.add();
  const blocked = s.add({ dependsOn: [failing.id] });
  await s.d.dispatch();
  assert.equal(s.task(b.id).status, "queued");
  s.link.results.set(s.task(a.id).threadId!, "A found 42");
  await s.shell([s.row(a.id, { status: "completed" }), s.row(failing.id, { status: "failed", lastError: "boom" })]);
  assert.equal(s.task(a.id).result, "A found 42");
  assert.equal(s.task(failing.id).status, "failed");
  assert.equal(s.task(failing.id).error, "boom");
  assert.equal(s.task(blocked.id).status, "queued");
  const launch = s.link.launches.find((l) => l.threadId === s.task(b.id).threadId)!;
  assert.match(launch.prompt, /^use it\n\nResults from earlier tasks:\n\n### Research\nA found 42$/);
});

test("offline machine keeps its queue", async (t) => {
  const s = setup(t);
  s.link.state = { ...s.link.state, status: "offline" };
  const a = s.add();
  await s.d.dispatch();
  assert.equal(s.task(a.id).status, "queued");
  assert.equal(s.link.launches.length, 0);
});

test("transport errors and crashes relaunch with the same ids; T3 rejections fail", async (t) => {
  const s = setup(t);
  s.link.launchError = new Error("socket closed");
  const a = s.add();
  await s.d.dispatch();
  const first = s.link.launches[0]!;
  assert.equal(s.task(a.id).status, "starting");
  assert.equal(s.task(a.id).threadId, first.threadId);
  for (const l of s.link.launches) assert.deepEqual(l, first);

  // A new process over the same DB (crash between persist and launch) relaunches with the same ids.
  s.link.launchError = null;
  const restarted = s.make();
  const n = s.link.launches.length;
  await restarted.dispatch();
  assert.equal(s.link.launches.length, n + 1);
  assert.deepEqual(s.link.launches.at(-1), first);

  // Launched but never seen: relaunch after 60 s, not before.
  s.clock.now += 30_000;
  await restarted.dispatch();
  assert.equal(s.link.launches.length, n + 1);
  s.clock.now += 31_000;
  await restarted.dispatch();
  assert.equal(s.link.launches.length, n + 2);
  assert.deepEqual(s.link.launches.at(-1), first);

  s.link.launchError = new T3Error("fail", "project not found");
  const b = s.add();
  await s.d.dispatch();
  assert.equal(s.task(b.id).status, "failed");
  assert.equal(s.task(b.id).error, "project not found");
});

test("status table", async (t) => {
  const cases: [Partial<ThreadRow>, string][] = [
    [{ status: "idle", activeRunId: null }, "starting"],
    [{ status: "preparing" }, "running"],
    [{ status: "queued" }, "running"],
    [{ status: "running" }, "running"],
    [{ status: "waiting" }, "running"],
    [{ pendingRequest: { id: "r1", kind: "command", summary: null, createdAt: iso(T0) } }, "needs_you"],
    [{ status: "failed", usageLimitResetAt: iso(T0 + 60_000) }, "waiting"],
    // T3 keeps usage-limit fields after a resume: only a failed run is limited.
    [{ status: "running", usageLimitResetAt: iso(T0 - 60_000) }, "running"],
    [{ status: "completed", usageLimitResetAt: iso(T0 - 60_000) }, "done"],
    [{ status: "failed", usageLimitResetAt: iso(T0 - 16 * 60_000) }, "failed"],
    [{ status: "completed" }, "done"],
    [{ status: "failed", lastError: "x" }, "failed"],
    [{ status: "interrupted" }, "cancelled"],
    [{ status: "cancelled" }, "cancelled"],
    [{ status: "rolled_back" }, "cancelled"],
  ];
  for (const [patch, expected] of cases) {
    const s = setup(t);
    const a = s.add();
    await s.d.dispatch();
    await s.shell([s.row(a.id, patch)]);
    assert.equal(s.task(a.id).status, expected, JSON.stringify(patch));
    assert.ok(s.task(a.id).threadSeenAt);
  }
});

test("usage limit: task waits, its provider pauses, another provider still dispatches", async (t) => {
  const s = setup(t, 2);
  s.link.providerList.push({ instanceId: "claude", driver: "claude", displayName: "Claude", enabled: true, installed: true, models: [{ slug: "opus", name: "Opus", isDefault: true }] });
  const a = s.add();
  await s.d.dispatch();
  const reset = iso(T0 + 3_600_000);
  await s.shell([s.row(a.id, { status: "failed", activeRunId: null, usageLimitResetAt: reset })]);
  assert.equal(s.task(a.id).status, "waiting");
  assert.equal(s.task(a.id).limitResetAt, reset);
  assert.deepEqual(s.d.pauses().map((p) => [p.instanceId, p.until]), [["codex", reset]]);

  const sameProvider = s.add();
  const other = s.add({ model: { instanceId: "claude", model: "opus" } });
  await s.d.dispatch();
  assert.equal(s.task(sameProvider.id).status, "queued");
  assert.equal(s.task(other.id).status, "starting");

  s.clock.now = Date.parse(reset) + 1;
  await s.shell([s.row(a.id), s.row(other.id)]);
  assert.equal(s.task(a.id).status, "running");
  assert.equal(s.task(a.id).limitResetAt, null);
  assert.equal(s.task(sameProvider.id).status, "queued"); // cap 2: a and other hold the slots
  await s.shell([s.row(a.id, { status: "completed" }), s.row(other.id)]);
  assert.equal(s.task(sameProvider.id).status, "starting");
});

test("stale usage-limit fields pause nothing; a limit T3 never resumes frees the slot", async (t) => {
  const s = setup(t, 1);
  const a = s.add();
  await s.d.dispatch();
  const stale = iso(T0 - 3_600_000);
  const other = { ...s.row(a.id), id: "other", usageLimitResetAt: stale };
  await s.shell([s.row(a.id, { status: "completed", usageLimitResetAt: stale }), other]);
  assert.equal(s.task(a.id).status, "done");
  assert.deepEqual(s.d.pauses(), []);

  const b = s.add();
  await s.d.dispatch();
  const reset = iso(s.clock.now + 60_000);
  const limited = () => s.row(b.id, { status: "failed", activeRunId: null, usageLimitResetAt: reset });
  await s.shell([limited()]);
  assert.equal(s.task(b.id).status, "waiting");
  s.clock.now = Date.parse(reset) + 16 * 60_000; // autoResume off: T3 sends nothing new
  await s.d.tick();
  assert.equal(s.task(b.id).status, "failed");
  assert.equal(s.task(b.id).error, "usage limit; resume in T3");
});

test("a cancel during a dispatch pass wins over the pass's stale snapshot", async (t) => {
  const s = setup(t, 3);
  let started!: () => void;
  let release!: () => void;
  const launched = new Promise<void>((r) => (started = r));
  const gate = new Promise<void>((r) => (release = r));
  s.link.launch = async (input: LaunchInput) => {
    s.link.launches.push(input);
    started();
    await gate;
    throw new T3Error("fail", "late");
  };
  s.link.state = { ...s.link.state, status: "offline" };
  const a = s.add();
  const b = s.add();
  s.link.state = { ...s.link.state, status: "online" };
  const pass = s.d.dispatch();
  await launched;
  await s.d.cancel(a.id); // launch in flight, no run visible yet
  await s.d.cancel(b.id); // still queued in the pass's snapshot
  release();
  await pass;
  assert.equal(s.link.launches.length, 1);
  assert.equal(s.task(a.id).status, "cancelled");
  assert.equal(s.task(a.id).error, "cancelled");
  assert.equal(s.task(b.id).status, "cancelled");

  // T3 started the run anyway: interrupt it once it shows up.
  await s.shell([s.row(a.id)]);
  await s.shell([s.row(a.id)]);
  assert.deepEqual(s.link.interrupts, [[s.task(a.id).threadId, `run-${a.id}`]]);
});

test("a removed or archived thread frees the slot", async (t) => {
  const s = setup(t, 1);
  const a = s.add();
  const b = s.add();
  await s.d.dispatch();
  await s.shell([s.row(a.id)]);
  assert.equal(s.task(b.id).status, "queued");
  await s.d.onShell("m1", { projects: [], threads: [], authoritative: false });
  await s.d.dispatch();
  assert.equal(s.task(a.id).status, "cancelled");
  assert.equal(s.task(a.id).error, "removed in T3");
  assert.equal(s.task(b.id).status, "starting");
});

test("agent tasks need approval and a runtime mode before they dispatch", async (t) => {
  const s = setup(t);
  const a = s.add({ runtimeMode: "full-access" }, "agent:hermes");
  assert.equal(a.status, "pending_approval");
  assert.equal(a.runtimeMode, null);
  await s.d.dispatch();
  assert.equal(s.link.launches.length, 0);
  assert.throws(() => s.d.approve(a.id, {}), (e: unknown) => e instanceof TaskError && e.code === "invalid");
  assert.equal(s.task(a.id).status, "pending_approval");
  s.d.approve(a.id, { runtimeMode: "auto" });
  await s.d.dispatch();
  assert.equal(s.link.launches[0]!.runtimeMode, "auto");

  const rejected = s.add({}, "agent:hermes");
  assert.equal(s.d.reject(rejected.id).status, "cancelled");
  assert.equal(s.d.retry(rejected.id).status, "pending_approval");
});

test("validation", (t) => {
  const s = setup(t);
  const invalid = (e: unknown) => e instanceof TaskError && e.code === "invalid";
  assert.throws(() => s.add({ projectId: "nope" }), invalid);
  assert.throws(() => s.add({ priority: 3 }), invalid);
  assert.throws(() => s.add({ prompt: "x".repeat(20_001) }), invalid);
  assert.throws(() => s.add({ prompt: "  " }), invalid);
  assert.throws(() => s.add({ dependsOn: ["ghost"] }), invalid);
  assert.throws(() => s.add({ workspace: { type: "worktree" } as never }), invalid);
  assert.throws(() => s.d.setPriority("ghost", 0), (e: unknown) => e instanceof TaskError && e.code === "not_found");
});

test("cancel, retry, no model", async (t) => {
  const s = setup(t);
  const a = s.add();
  await s.d.dispatch();
  await s.shell([s.row(a.id)]);
  const cancelled = await s.d.cancel(a.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(s.link.interrupts, [[cancelled.threadId, `run-${a.id}`]]);

  const retried = s.d.retry(a.id);
  assert.equal(retried.threadId, null);
  await s.d.dispatch();
  assert.notEqual(s.task(a.id).threadId, cancelled.threadId);

  s.link.providerList = [];
  const b = s.add();
  await s.d.dispatch();
  assert.equal(s.task(b.id).status, "failed");
  assert.equal(s.task(b.id).error, "no model");
});
