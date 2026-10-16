import assert from "node:assert/strict";
import test from "node:test";
import type { TaskItem, TaskStatus, ThreadItem } from "../../server/types.ts";
import type { WorkMachine, WorkRow } from "../../server/work.ts";
import { BUCKETS, buildWork, entryAction, entryWhy, groupByBucket, NO_FILTERS, searchWork, tabCounts, tidyLanes, workPage, type MachineInfo } from "./workDirectory.ts";

const now = Date.parse("2026-01-02T00:00:00Z");
const task = (id: string, status: TaskStatus, over: Partial<TaskItem> = {}): TaskItem => ({
  id, status, machineId: "a", priority: 0, title: `Tarea ${id}`, prompt: "Revisar notas", projectId: "p", projectTitle: "Hermes", machineLabel: "Desktop",
  model: null, runtimeMode: null, interactionMode: "default", workspace: { type: "root" }, dependsOn: [], source: "user", commandId: null, threadId: null, threadSeenAt: null,
  limitResetAt: null, error: null, result: null, createdAt: "", updatedAt: "2026-01-01T10:00:00Z", startedAt: null, finishedAt: null, blockedBy: [], ...over,
});
const row = (key: string, over: Partial<WorkRow> = {}): WorkRow => ({
  key, title: `Rama ${key}`, branch: `feat/${key}`, worktreePath: null, threadCount: 1, taskId: null, agent: "idle", stage: 1, blocked: null, tidy: null,
  changedFiles: null, ahead: null, behind: null, pr: null, note: null, updatedAt: "2026-01-01T09:00:00Z", appUrl: `t3code://${key}`, webUrl: null, ...over,
});
const thread = (key: string, appUrl: string, over: Partial<ThreadItem> = {}): ThreadItem => ({
  key, machineId: "a", threadId: key.split(":")[1]!, projectId: "p", title: key, status: "waiting", taskId: null, pending: null, planReady: false,
  waitingUntil: null, preview: null, failed: false, updatedAt: "", appUrl, webUrl: null, ...over,
});
const work = (rows: WorkRow[]): WorkMachine[] => [{ id: "a", label: "Desktop", status: "online", lanes: [{ projectId: "p", title: "Hermes", rows }] }];
const machines: MachineInfo[] = [{ id: "a", label: "Desktop", status: "online" }];
const build = (queue: TaskItem[], rows: WorkRow[] = [], threads: ThreadItem[] = []) => buildWork({ queue, work: work(rows), machines, threads, now });

test("a task and its branch are one entry; lone branches stand alone", () => {
  const entries = build([task("t1", "running", { threadId: "x" })], [row("r1", { taskId: "t1", stage: 3 }), row("r2")]);
  assert.deepEqual(entries.map((e) => e.key), ["task:t1", "branch:r2"]);
  assert.equal(entries[0]!.row?.stage, 3);
  assert.equal(entries[1]!.task, null);
});

test("status decides the group: approvals, fresh failures and questions need you, finished PRs wait for merge", () => {
  const entries = build(
    [task("ap", "pending_approval"), task("fresh", "failed", { finishedAt: "2026-01-01T20:00:00Z" }), task("stale", "failed", { finishedAt: "2025-12-20T00:00:00Z" }),
      task("q", "queued"), task("run", "running"), task("wait", "waiting"), task("pr", "done"), task("done", "done"), task("x", "cancelled")],
    [row("r-pr", { taskId: "pr", pr: { number: 1, url: "u", state: "open", isDraft: false } }), row("work", { agent: "working" }), row("ask", { agent: "needs-you" }), row("old", { tidy: "merged" }), row("quiet")],
  );
  const bucket = Object.fromEntries(entries.map((e) => [e.key.replace(/^(task|branch):/, ""), e.bucket]));
  assert.deepEqual(bucket, { ap: "need", fresh: "need", ask: "need", pr: "pr", run: "run", wait: "run", work: "run", q: "queue", quiet: "idle", stale: "done", done: "done", x: "done", old: "done" });
  const ranks = entries.map((e) => BUCKETS.indexOf(e.bucket));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test("the queue keeps the server's dispatch order", () => {
  assert.deepEqual(build([task("b", "queued"), task("a", "queued")]).map((e) => e.task!.id), ["b", "a"]);
});

test("filters combine search, project and machine; tab counts follow them", () => {
  const entries = build([task("one", "queued"), task("two", "running", { machineId: "b", machineLabel: "Laptop", projectId: "z", projectTitle: "Otro" }), task("three", "done")]);
  assert.deepEqual(searchWork(entries, { ...NO_FILTERS, query: " REVISAR hermes " }).map((e) => e.task!.id), ["one", "three"]);
  assert.deepEqual(searchWork(entries, { ...NO_FILTERS, machineId: "b" }).map((e) => e.task!.id), ["two"]);
  assert.deepEqual(searchWork(entries, { ...NO_FILTERS, projectKey: "a:p" }).map((e) => e.task!.id), ["one", "three"]);
  assert.deepEqual(tabCounts(entries), { all: 3, need: 0, run: 1, queue: 1, done: 1 });
});

test("only history is paged: actionable groups come back whole", () => {
  const queue = [
    ...Array.from({ length: 12 }, (_, i) => task(`n${i}`, "pending_approval")),
    ...Array.from({ length: 20 }, (_, i) => task(`d${i}`, "done", { updatedAt: `2026-01-01T10:${String(i).padStart(2, "0")}:00Z` })),
  ];
  const found = searchWork(build(queue), NO_FILTERS);
  const first = workPage(found, "all", 1, 8);
  assert.equal(first.actionable[0]!.items.length, 12);
  assert.equal(first.history.items.length, 8);
  assert.equal(first.history.total, 20);
  assert.equal(first.history.items[0]!.task!.id, "d19");
  assert.equal(workPage(found, "all", 3, 8).history.items.length, 4);
  assert.deepEqual(workPage(found, "need", 1).history.items, []);
  assert.deepEqual(groupByBucket(first.history.items).map((g) => g.bucket), ["done"]);
});

test("each entry offers the one action that fits", () => {
  const th = thread("a:t", "t3code://t", { planReady: true });
  const entries = build(
    [task("ap", "pending_approval"), task("fail", "failed", { finishedAt: "2026-01-01T20:00:00Z" }), task("plan", "needs_you", { threadId: "t" }), task("pr", "done"), task("run", "running")],
    [row("r", { taskId: "pr", pr: { number: 7, url: "https://x/7", state: "open", isDraft: false } })],
    [th],
  );
  const action = (id: string) => entryAction(entries.find((e) => e.key === `task:${id}`)!);
  assert.deepEqual(action("ap"), { label: "Aprobar", kind: "detail" });
  assert.deepEqual(action("fail"), { label: "Reintentar", kind: "retry" });
  assert.deepEqual(action("plan"), { label: "Revisar plan", kind: "thread" });
  assert.deepEqual(action("pr"), { label: "Ver PR", kind: "pr", href: "https://x/7" });
  assert.equal(action("run"), null);
});

test("an entry opens the thread only when the view still lists it, found by task or by branch link", () => {
  const th = thread("a:t", "t3code://r1");
  assert.equal(build([task("t1", "needs_you", { threadId: "t" })], [], [th])[0]!.thread, th);
  assert.equal(build([task("t1", "needs_you", { threadId: "t" })])[0]!.thread, null);
  assert.equal(build([], [row("r1", { agent: "needs-you" })], [th])[0]!.thread, th);
});

test("blocked tasks name what they wait for; tidy lanes count merged and stale branches", () => {
  const entries = build([task("a", "queued"), task("b", "queued", { blockedBy: ["a", "gone"] })]);
  assert.deepEqual(entries.find((e) => e.key === "task:b")!.blockedBy, ["Tarea a", "gone"]);
  const rows = [row("m", { tidy: "merged" }), row("s", { tidy: "stale" }), row("n")];
  assert.deepEqual(tidyLanes(work(rows)).map((l) => [l.projectKey, l.count]), [["a:p", 2]]);
});

test("entries explain themselves in one line", () => {
  const th = thread("a:t", "t3code://t", { pending: { id: "r", kind: "command", summary: "pnpm test", createdAt: "" } });
  const entries = build(
    [task("ap", "pending_approval", { source: "agent:Hermes" }), task("bad", "failed", { error: "Fallaron 2 suites\nmás", finishedAt: "2026-01-01T20:00:00Z" }), task("ask", "needs_you", { threadId: "t" }),
      task("b", "queued", { blockedBy: ["ap"] }), task("hi", "queued", { priority: 2 }), task("plain", "queued")],
    [],
    [th],
  );
  const why = (id: string) => entryWhy(entries.find((e) => e.key === `task:${id}`)!);
  assert.equal(why("ap"), "Hermes quiere encolar esta tarea");
  assert.equal(why("bad"), "Fallaron 2 suites");
  assert.equal(why("ask"), "Ejecutar un comando · pnpm test");
  assert.equal(why("b"), "Espera a Tarea ap");
  assert.equal(why("hi"), "Prioridad urgente");
  assert.equal(why("plain"), "");
});
