import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeView, NeedsYouItem, TaskItem, TaskStatus, ThreadItem } from "../../server/types.ts";
import { homeAttention, homeThread, matchesSearch, queueGroup, queueResults } from "./homeQueueView.ts";
import { paginateCollection } from "./pagination.ts";

const task = (id: string, status: TaskStatus, machineId = "a", priority = 0): TaskItem => ({
  id, status, machineId, priority, title: `Task ${id}`, prompt: "Review release notes", projectId: "p", projectTitle: "Hermes", machineLabel: machineId === "a" ? "Desktop" : "Laptop",
  model: null, runtimeMode: null, interactionMode: "default", workspace: { type: "root" }, dependsOn: [], source: "user", commandId: null, threadId: null, threadSeenAt: null,
  limitResetAt: null, error: null, result: null, createdAt: "", updatedAt: "", startedAt: null, finishedAt: null, blockedBy: [],
});
const thread = (key: string): ThreadItem => ({
  key, machineId: "a", threadId: key, projectId: "p", title: key, status: "running", taskId: null, pending: null, planReady: false,
  waitingUntil: null, preview: null, failed: false, updatedAt: "", appUrl: "", webUrl: null,
});

test("home keeps every alert visible while paging actions, and resolves off-page sheets", () => {
  const needs: NeedsYouItem[] = Array.from({ length: 12 }, (_, i) => ({ kind: "thread", thread: thread(`needs-${i}`), reason: "input", since: "" }));
  needs.splice(8, 0, { kind: "alert", since: "", alert: { key: "offline:a", machineId: "a", kind: "offline", message: "Desktop offline", since: "" } });
  const { alerts, actions } = homeAttention(needs);
  assert.equal(alerts.length, 1);
  assert.equal(actions.length, 12);
  assert.equal(paginateCollection(actions, 1, 5).items.length, 5);
  const view: HomeView = { machines: [], needsYou: needs, running: Array.from({ length: 11 }, (_, i) => thread(`running-${i}`)), done: [thread("done")], queue: [] };
  assert.equal(homeThread(view, "needs-11")?.key, "needs-11");
  assert.equal(homeThread(view, "running-10")?.key, "running-10");
  assert.equal(homeThread(view, "done")?.key, "done");
  assert.equal(homeThread(view, "missing"), undefined);
  assert.equal(homeThread(view, null), undefined);
});

test("queue groups every status without changing server order within a group", () => {
  const tasks = [task("q-low", "queued", "a", -2), task("fail", "failed"), task("run", "running"), task("approve", "pending_approval"), task("q-high", "queued", "a", 2), task("cancel", "cancelled"), task("wait", "waiting"), task("done", "done"), task("start", "starting"), task("input", "needs_you")];
  const original = tasks.map((t) => t.id);
  const results = queueResults(tasks, "", "", "");
  assert.deepEqual(results.map((t) => t.id), ["approve", "run", "wait", "start", "input", "q-low", "q-high", "fail", "cancel", "done"]);
  assert.deepEqual(tasks.map((t) => t.id), original);
  const pages = [1, 2].flatMap((p) => paginateCollection(results, p, 5).items);
  assert.deepEqual(pages.map((t) => t.id), results.map((t) => t.id));
  assert.equal(queueGroup("needs_you"), "Ongoing");
});

test("queue combines machine, exact status and multi-word search before pagination", () => {
  const tasks = [task("one", "queued"), task("two", "queued", "b"), task("three", "running")];
  assert.deepEqual(queueResults(tasks, "  RELEASE hermes DESKTOP ", "a", "queued").map((t) => t.id), ["one"]);
  assert.deepEqual(queueResults(tasks, "laptop", "", "").map((t) => t.id), ["two"]);
  assert.deepEqual(queueResults(tasks, "missing", "", ""), []);
  assert.deepEqual(queueResults(tasks, "", "a", "running").map((t) => t.id), ["three"]);
});

test("workflow search matches across supplied fields and tolerates missing descriptions", () => {
  assert.equal(matchesSearch("release DEPLOY", "Release notes", "deploy-flow", undefined), true);
  assert.equal(matchesSearch("approval", "Release", "Pending approval"), true);
  assert.equal(matchesSearch("unknown", "Release", null), false);
  assert.equal(matchesSearch("   ", "Release", undefined), true);
});
