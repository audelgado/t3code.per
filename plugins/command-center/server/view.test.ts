import assert from "node:assert/strict";
import { test } from "node:test";
import type { LinkState, Machine, Task, ThreadRow } from "./types.ts";
import { buildHomeView, compareVersions, hashView, type ViewInput } from "./view.ts";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const machine = (id: string, patch: Partial<Machine> = {}): Machine => ({
  id,
  label: id.toUpperCase(),
  apiUrl: `https://${id}`,
  webUrl: null,
  maxConcurrent: 2,
  enabled: true,
  serverVersion: null,
  tokenExpiresAt: null,
  createdAt: ago(10 * 24 * HOUR),
  ...patch,
});
const link = (patch: Partial<LinkState> = {}): LinkState => ({
  status: "online",
  since: ago(HOUR),
  degraded: false,
  droppedRows: 0,
  unknownItems: 0,
  serverVersion: null,
  message: null,
  ...patch,
});
const thread = (id: string, patch: Partial<ThreadRow> = {}): ThreadRow => ({
  machineId: "m1",
  id,
  projectId: "p1",
  title: id,
  status: "running",
  activityRunStatus: "running",
  activeRunId: `run-${id}`,
  pendingRequest: null,
  hasActionableProposedPlan: false,
  lastError: null,
  usageLimitResetAt: null,
  relationshipToParent: null,
  snoozedUntil: null,
  settledAt: null,
  providerInstanceId: "codex",
  completedAt: null,
  createdAt: ago(HOUR),
  updatedAt: ago(MIN),
  ...patch,
});
const done = (id: string, completedMsAgo: number, patch: Partial<ThreadRow> = {}) =>
  thread(id, { status: "completed", activeRunId: null, activityRunStatus: null, completedAt: ago(completedMsAgo), ...patch });
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: id,
  prompt: "p",
  machineId: "m1",
  projectId: "p1",
  model: null,
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  workspace: { type: "root" },
  priority: 0,
  dependsOn: [],
  source: "user",
  status: "queued",
  commandId: null,
  threadId: null,
  threadSeenAt: null,
  limitResetAt: null,
  error: null,
  result: null,
  createdAt: ago(HOUR),
  updatedAt: ago(HOUR),
  startedAt: null,
  finishedAt: null,
  ...patch,
});
const input = (patch: Partial<ViewInput> = {}): ViewInput => ({
  machines: [machine("m1", { webUrl: "https://web" })],
  linkStates: { m1: link() },
  projects: [{ machineId: "m1", id: "p1", title: "App", workspaceRoot: "/srv/app", defaultModel: null, updatedAt: ago(HOUR) }],
  threads: [],
  tasks: [],
  threadLinks: (m, id) => ({ appUrl: `t3code://threads/${m.id}/${id}`, webUrl: m.webUrl && `${m.webUrl}/${m.id}/${id}` }),
  ...patch,
});

test("caps, 24 h done window, preview, forks shown, subagents hidden", () => {
  const threads = [
    ...Array.from({ length: 60 }, (_, i) => thread(`r${String(i).padStart(2, "0")}`)),
    ...Array.from({ length: 40 }, (_, i) => done(`d${String(i).padStart(2, "0")}`, (i + 1) * MIN)),
    done("old", 25 * HOUR),
    done("fork", 30 * 1000, { relationshipToParent: "fork" }),
    thread("sub", { relationshipToParent: "subagent" }),
    done("cc", 10 * 1000, { status: "failed" }),
  ];
  const view = buildHomeView(input({ threads, tasks: [task("t1", { status: "done", threadId: "cc", result: "x".repeat(500) })] }), NOW);
  assert.equal(view.running.length, 50);
  assert.equal(view.done.length, 30);
  assert.deepEqual(view.done.slice(0, 3).map((d) => d.threadId), ["cc", "fork", "d00"]);
  assert.equal(view.done[0]!.preview!.length, 200);
  assert.equal(view.done[0]!.taskId, "t1");
  assert.equal(view.done[0]!.failed, true);
  assert.equal(view.done[0]!.webUrl, "https://web/m1/cc");
  const all = [...view.running, ...view.done].map((d) => d.threadId);
  assert.ok(!all.includes("old"));
  assert.ok(!all.includes("sub"));
});

test("needs-you order and the snooze rule", () => {
  const pending = (createdMsAgo: number, kind = "command") => ({ id: "req", kind, summary: null, createdAt: ago(createdMsAgo) });
  const view = buildHomeView(
    input({
      threads: [
        thread("newer", { pendingRequest: pending(MIN) }),
        thread("older", { pendingRequest: pending(HOUR, "user_input") }),
        done("plan", MIN, { hasActionableProposedPlan: true }),
        done("settledPlan", MIN, { hasActionableProposedPlan: true, settledAt: ago(MIN) }),
        thread("snoozedAsking", { snoozedUntil: ago(-HOUR), pendingRequest: pending(2 * MIN) }),
        thread("snoozed", { snoozedUntil: ago(-HOUR) }),
        thread("woke", { snoozedUntil: ago(MIN) }),
      ],
      tasks: [task("agent", { status: "pending_approval", runtimeMode: null, source: "agent:hermes" })],
      workflowNeeds: [
        { runId: "r2", title: "Flow", kind: "run_approval", nodeId: null, text: "agent:bot wants to run this workflow.", choices: null, since: ago(MIN) },
        { runId: "r1", title: "Flow", kind: "gate", nodeId: "ok", text: 'Pass "ok"?', choices: null, since: ago(HOUR) },
      ],
      linkStates: { m1: link({ degraded: true, droppedRows: 1 }) },
    }),
    NOW,
  );
  assert.deepEqual(
    view.needsYou.map((n) =>
      n.kind === "thread" ? `${n.reason}:${n.thread.threadId}` : n.kind === "task_approval" ? `task:${n.task.id}` : n.kind === "workflow" ? n.key : `alert:${n.alert.kind}`,
    ),
    ["input:older", "approval:snoozedAsking", "approval:newer", "plan:plan", "task:agent", "workflow:r1:ok", "workflow:r2:approval", "alert:degraded"],
  );
  assert.deepEqual(view.running.map((r) => r.threadId), ["woke"]);
});

test("alerts: offline with a queue for 15 min, incompatible, token expiry, version skew, provider pause", () => {
  const view = buildHomeView(
    input({
      machines: [machine("m1", { tokenExpiresAt: ago(-10 * 24 * HOUR) }), machine("m2"), machine("m3"), machine("m4")],
      linkStates: {
        m1: link({ serverVersion: "0.9.0" }),
        m2: link({ status: "offline", since: ago(20 * MIN), serverVersion: "0.10.0" }),
        m3: link({ status: "offline", since: ago(5 * MIN) }),
        m4: link({ status: "incompatible" }),
      },
      tasks: [task("q2", { machineId: "m2" }), task("q3", { machineId: "m3" })],
      pauses: [
        { machineId: "m1", instanceId: "codex", since: ago(MIN), until: ago(-HOUR) },
        { machineId: "m1", instanceId: "claude", since: ago(2 * HOUR), until: ago(HOUR) },
      ],
    }),
    NOW,
  );
  const keys = view.needsYou.flatMap((n) => (n.kind === "alert" ? [n.alert.key] : [])).sort();
  assert.deepEqual(keys, ["incompatible:m4", "offline:m2", "provider_paused:m1:codex", "token_expiring:m1", "version_skew:m1"]);
  assert.equal(view.machines.find((m) => m.id === "m2")!.queued, 1);
});

test("queue: approvals first, every unfinished task, recent failures; blockedBy", () => {
  const view = buildHomeView(
    input({
      tasks: [
        task("low", { priority: -1, createdAt: ago(3 * HOUR) }),
        task("a", { createdAt: ago(2 * HOUR) }),
        task("b", { createdAt: ago(HOUR), dependsOn: ["a", "fin"] }),
        task("fin", { status: "done" }),
        task("starting", { status: "starting", priority: 2, threadId: "x" }),
        task("seen", { status: "starting", threadId: "y", threadSeenAt: ago(MIN) }),
        task("approval", { status: "pending_approval", runtimeMode: null, priority: -2, source: "agent:hermes" }),
        task("launchFailed", { status: "failed", error: "no model", finishedAt: ago(MIN) }),
        task("oldFail", { status: "failed", finishedAt: ago(25 * HOUR) }),
      ],
    }),
    NOW,
  );
  assert.deepEqual(view.queue.map((t) => t.id), ["approval", "starting", "a", "b", "launchFailed", "seen", "low"]);
  assert.deepEqual(view.queue[3]!.blockedBy, ["a"]);
  assert.equal(view.queue[0]!.projectTitle, "App");
  assert.equal(view.machines[0]!.running, 2);
});

test("usage limit: only a failed run with a reset time waits, until 15 min past the reset", () => {
  const view = buildHomeView(
    input({
      threads: [
        thread("limited", { status: "failed", activeRunId: null, activityRunStatus: null, usageLimitResetAt: ago(-HOUR) }),
        thread("resumed", { usageLimitResetAt: ago(HOUR) }),
        done("staleDone", MIN, { usageLimitResetAt: ago(HOUR) }),
        done("abandoned", MIN, { status: "failed", usageLimitResetAt: ago(HOUR) }),
      ],
    }),
    NOW,
  );
  assert.deepEqual(
    view.running.map((r) => [r.threadId, r.waitingUntil]),
    [
      ["limited", ago(-HOUR)],
      ["resumed", null],
    ],
  );
  assert.deepEqual(view.done.map((d) => d.threadId).sort(), ["abandoned", "staleDone"]);
});

test("identical input gives an identical hash", () => {
  const make = () => buildHomeView(input({ threads: [thread("a"), done("b", MIN)], tasks: [task("t")] }), NOW);
  assert.equal(hashView(make()), hashView(make()));
  assert.notEqual(hashView(make()), hashView(buildHomeView(input({ threads: [thread("a")] }), NOW)));
});

test("compareVersions is numeric", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});
