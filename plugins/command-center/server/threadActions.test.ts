import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "./http.ts";
import { threadRoutes } from "./threadActions.ts";
import { T3Error, type LinkState, type PendingRequest, type T3Link, type ThreadRow } from "./types.ts";

const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  machineId: "m1", id: "t1", projectId: "p1", title: "T", status: "running", activityRunStatus: "running", activeRunId: "run1",
  pendingRequest: null, hasActionableProposedPlan: false, lastError: null, usageLimitResetAt: null, relationshipToParent: null,
  snoozedUntil: null, settledAt: null, providerInstanceId: "codex", completedAt: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z",
  ...over,
});
const pending = (kind: string, id = "r1"): PendingRequest => ({ id, kind, summary: null, createdAt: "2026-10-15T00:00:00.000Z" });

function setup(rows: ThreadRow[], status: LinkState["status"] = "online") {
  const calls: unknown[][] = [];
  const link = {
    machineId: "m1",
    state: { status } as LinkState,
    respond: async (...a: unknown[]) => void calls.push(["respond", ...a]),
    interrupt: async (...a: unknown[]) => void calls.push(["interrupt", ...a]),
    settle: async (...a: unknown[]) => void calls.push(["settle", ...a]),
    readResult: async () => ({ text: "done it", pending: { ...pending("command"), summary: "rm -rf x" } }),
  } as unknown as T3Link;
  const routes = threadRoutes({ links: (id) => (id === "m1" ? link : undefined), threads: () => rows });
  // suffix "" is the GET detail route.
  const call = (method: string, suffix: string, body?: unknown, machine = "m1") => {
    const route = routes.find((r) => r.method === method && r.path.endsWith(suffix || ":thread"))!;
    return Promise.resolve(route.handler({ params: { machine, thread: "t1" }, body } as never));
  };
  return { calls, call, link };
}
const rejects = (p: Promise<unknown>, status: number, code?: string) =>
  assert.rejects(p, (e) => e instanceof HttpError && e.status === status && (code === undefined || e.code === code));

test("respond sends the contract payload for approval kinds", async () => {
  for (const decision of ["accept", "acceptForSession", "decline"]) {
    const s = setup([row({ pendingRequest: pending("file-change") })]);
    assert.deepEqual(await s.call("POST", "respond", { requestId: "r1", decision }), { ok: true });
    assert.deepEqual(s.calls, [["respond", "t1", "r1", decision]]);
  }
});

test("MCP tool permission can be approved in the same conversation", async () => {
  const s = setup([row({ pendingRequest: pending("mcp-elicitation") })]);
  s.link.readResult = async () => ({ text: null, pending: { ...pending("mcp-elicitation"), summary: "Allow delegate_task?" } });
  assert.equal((await s.call("GET", "") as { answerable: boolean }).answerable, true);
  await s.call("POST", "respond", { requestId: "r1", decision: "accept" });
  assert.deepEqual(s.calls, [["respond", "t1", "r1", "accept"]]);
});

test("question answers are validated against fresh questions on the exact thread", async () => {
  const s = setup([row({ pendingRequest: pending("user_input", "q") })]);
  s.link.answerInput = async (...args) => void s.calls.push(["answer", ...args]);
  s.link.readResult = async () => ({ text: null, pending: { ...pending("user_input", "q"), questions: [{ id: "where", header: "Sistema", question: "¿Dónde?", options: [], allowCustomAnswer: true }] } });
  await rejects(s.call("POST", "answer", { requestId: "q", answers: {} }), 400);
  await rejects(s.call("POST", "answer", { requestId: "old", answers: { where: "Tayna" } }), 409);
  await s.call("POST", "answer", { requestId: "q", answers: { where: "Tayna" } });
  assert.deepEqual(s.calls, [["answer", "t1", "q", { where: "Tayna" }]]);
  s.link.readResult = async () => ({ text: null, pending: null });
  await rejects(s.call("POST", "answer", { requestId: "q", answers: { where: "PC" } }), 409);
  assert.equal(s.calls.length, 1);
});

test("continuing a finished thread keeps its identity and retry command; active and pending threads reject", async () => {
  const s = setup([row({ status: "completed", activeRunId: null })]);
  s.link.sendMessage = async (...args) => void s.calls.push(["message", ...args]);
  const body = { text: " Seguí con la revisión ", commandId: "ced9f345-6071-4038-b77d-55a1e094d3d1" };
  await s.call("POST", "message", body);
  assert.deepEqual(s.calls, [["message", "t1", "Seguí con la revisión", body.commandId]]);
  await rejects(s.call("POST", "message", { ...body, text: " " }), 400);
  const active = setup([row()]);
  active.link.sendMessage = s.link.sendMessage;
  await rejects(active.call("POST", "message", body), 409, "busy");
});

test("respond rejects unsupported kinds, stale ids and bad decisions", async () => {
  const s = setup([row({ pendingRequest: pending("user_input") })]);
  await rejects(s.call("POST", "respond", { requestId: "r1", decision: "accept" }), 409, "unsupported");
  await rejects(s.call("POST", "respond", { requestId: "other", decision: "accept" }), 409, "stale");
  await rejects(s.call("POST", "respond", { requestId: "r1", decision: "cancel" }), 400);
  assert.equal(s.calls.length, 0);
});

test("stop interrupts the active run; no run is 409", async () => {
  const s = setup([row()]);
  await s.call("POST", "stop");
  assert.deepEqual(s.calls, [["interrupt", "t1", "run1"]]);
  await rejects(setup([row({ activeRunId: null })]).call("POST", "stop"), 409, "no_run");
});

test("settle calls the link", async () => {
  const s = setup([row({ status: "completed" })]);
  await s.call("POST", "settle");
  assert.deepEqual(s.calls, [["settle", "t1"]]);
});

test("offline machine is 503, unknown thread 404, T3 rejection 502", async () => {
  const off = setup([row()], "offline");
  await rejects(off.call("POST", "stop"), 503);
  await rejects(off.call("GET", ""), 503);
  await rejects(setup([row()]).call("POST", "stop", undefined, "nope"), 404);
  const s = setup([row()]);
  s.link.settle = async () => Promise.reject(new T3Error("fail", "no"));
  await rejects(s.call("POST", "settle"), 502, "t3_error");
});

test("detail merges the live request id with the summary and flags answerable", async () => {
  const d = (await setup([row({ pendingRequest: pending("command") })]).call("GET", "")) as { text: string; pending: PendingRequest; answerable: boolean };
  assert.equal(d.text, "done it");
  assert.equal(d.pending.summary, "rm -rf x");
  assert.equal(d.answerable, true);
  const q = (await setup([row({ pendingRequest: pending("user_input", "q") })]).call("GET", "")) as { pending: PendingRequest; answerable: boolean };
  assert.equal(q.pending.id, "q");
  assert.equal(q.answerable, false);
});
