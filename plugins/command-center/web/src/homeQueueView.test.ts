import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeView, NeedsYouItem, TaskItem, TaskStatus, ThreadItem } from "../../server/types.ts";
import { homeCounts, homeNeeds, homeThread, matchesSearch, planSteps, threadReason, threadWhy, type HomeNeedContext } from "./homeQueueView.ts";

const task = (id: string, status: TaskStatus, over: Partial<TaskItem> = {}): TaskItem => ({
  id, status, machineId: "a", priority: 0, title: `Tarea ${id}`, prompt: "Revisar notas", projectId: "p", projectTitle: "Hermes", machineLabel: "Desktop",
  model: null, runtimeMode: null, interactionMode: "default", workspace: { type: "root" }, dependsOn: [], source: "user", commandId: null, threadId: null, threadSeenAt: null,
  limitResetAt: null, error: null, result: null, createdAt: "", updatedAt: "2026-01-01T10:00:00Z", startedAt: null, finishedAt: null, blockedBy: [], ...over,
});
const thread = (key: string, over: Partial<ThreadItem> = {}): ThreadItem => ({
  key, machineId: "a", threadId: key, projectId: "p", title: key, status: "running", taskId: null, pending: null, planReady: false,
  waitingUntil: null, preview: null, failed: false, updatedAt: "", appUrl: "", webUrl: null, ...over,
});
const ctx: HomeNeedContext = {
  projectTitle: (k) => (k === "a:p" ? "funder-api" : undefined),
  hashes: { thread: (k) => `#item=${k}`, task: (id) => `#work?task=${id}`, run: (id) => `#run=${id}`, fleet: "#fleet" },
  now: Date.parse("2026-01-01T12:00:00Z"),
};
const view = (needsYou: NeedsYouItem[], queue: TaskItem[] = [], extra: Partial<HomeView> = {}): HomeView => ({
  machines: [{ id: "a", label: "Desktop" } as HomeView["machines"][number]], needsYou, running: [], done: [], queue, ...extra,
});

test("threads say why they need you", () => {
  const approval = thread("t1", { pending: { id: "r", kind: "file-change", summary: "src/a.ts", createdAt: "" } });
  assert.equal(threadReason(approval), "approval");
  assert.equal(threadWhy(approval), "Cambiar archivos · src/a.ts");
  assert.equal(threadReason(thread("t2", { pending: { id: "r", kind: "user_input", summary: null, createdAt: "" } })), "input");
  assert.equal(threadReason(thread("t3", { planReady: true })), "plan");
  assert.equal(threadReason(thread("t4")), null);
});

test("hoy lists everything waiting on you oldest first, alerts last, never paged", () => {
  const needs: NeedsYouItem[] = [
    { kind: "alert", since: "2026-01-01T08:00:00Z", alert: { key: "offline:a", machineId: "a", kind: "offline", message: "Desktop sin conexión", since: "" } },
    ...Array.from({ length: 12 }, (_, i): NeedsYouItem => ({ kind: "thread", thread: thread(`t${i}`, { planReady: true }), reason: "plan", since: `2026-01-01T09:${String(59 - i).padStart(2, "0")}:00Z` })),
    { kind: "task_approval", since: "2026-01-01T09:00:00Z", task: task("ap", "pending_approval", { source: "agent:Hermes" }) },
  ];
  const rows = homeNeeds(view(needs), ctx);
  assert.equal(rows.length, 14);
  assert.equal(rows.at(-1)!.alert, true);
  assert.equal(rows[0]!.key, "task:ap");
  assert.equal(rows[0]!.why, "Hermes quiere encolar esta tarea");
  assert.deepEqual(rows[0]!.action, { label: "Aprobar", href: "#work?task=ap" });
  const first = rows.find((r) => r.key === "t11")!;
  assert.equal(first.project, "funder-api");
  assert.deepEqual(first.action, { label: "Revisar plan", href: "#item=t11" });
});

test("tasks that failed in the last day can be retried from hoy; older ones are history", () => {
  const failed = task("new", "failed", { error: "Fallaron 2 suites\nstack", finishedAt: "2026-01-01T11:00:00Z" });
  const rows = homeNeeds(view([], [failed, task("old", "failed", { finishedAt: "2025-12-30T11:00:00Z" }), task("ok", "done")]), ctx);
  assert.deepEqual(rows.map((r) => r.key), ["task:new"]);
  assert.equal(rows[0]!.why, "Fallaron 2 suites");
  assert.deepEqual(rows[0]!.action, { label: "Reintentar", retry: "new" });
});

test("counts, and sheets resolve off-page threads", () => {
  const v = view([], [task("q", "queued"), task("r", "running")], { running: [thread("r1")], done: [thread("d1"), thread("d2")] });
  assert.deepEqual(homeCounts(v, 3), { needs: 3, running: 1, queued: 1, done: 2 });
  assert.equal(homeThread(v, "d2")?.key, "d2");
  assert.equal(homeThread(v, null), undefined);
});

test("a plan text becomes its steps; prose stays prose", () => {
  assert.deepEqual(planSteps("Plan:\n1. **Congelar** escrituras\n2) Hacer `snapshot`\n- Verificar totales\n\nListo."), ["Congelar escrituras", "Hacer snapshot", "Verificar totales"]);
  assert.equal(planSteps("Voy a hacerlo todo en un paso."), null);
  assert.equal(planSteps("1. Solo uno"), null);
  assert.equal(planSteps(null), null);
});

test("search matches every word across the supplied fields and tolerates missing ones", () => {
  assert.equal(matchesSearch("release DEPLOY", "Release notes", "deploy-flow", undefined), true);
  assert.equal(matchesSearch("unknown", "Release", null), false);
  assert.equal(matchesSearch("   ", "Release", undefined), true);
});
