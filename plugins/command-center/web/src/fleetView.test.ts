import assert from "node:assert/strict";
import test from "node:test";
import type { HomeView, TaskItem, TaskStatus, ThreadItem } from "../../server/types.ts";
import { gb, lanesByMachine, loadTone, tokenExpiring, type LaneId } from "./fleetView.ts";

const task = (id: string, status: TaskStatus, machineId = "a") => ({ id, status, machineId, projectId: "p", title: id }) as TaskItem;
const thread = (key: string, machineId = "a", taskId: string | null = null) => ({ key, machineId, projectId: "p", title: key, taskId }) as ThreadItem;

test("lanes: tasks go by status, loose threads by list, task threads are not counted twice", () => {
  const view = {
    machines: [],
    queue: [task("q", "queued"), task("r", "running"), task("w", "waiting"), task("ap", "pending_approval"), task("f", "failed", "b"), task("c", "cancelled")],
    needsYou: [
      { kind: "thread", reason: "input", since: "", thread: thread("ask") },
      { kind: "thread", reason: "input", since: "", thread: thread("ask-task", "a", "r") },
    ],
    running: [thread("loose"), thread("of-task", "a", "r")],
    done: [thread("fin", "b")],
  } as unknown as HomeView;
  const lanes = lanesByMachine(view);
  const ids = (m: string, l: LaneId) => lanes.get(m)![l].map((i) => i.key);
  assert.deepEqual(ids("a", "queued"), ["task:q"]);
  assert.deepEqual(ids("a", "running"), ["task:r", "task:w", "thread:loose"]);
  assert.deepEqual(ids("a", "needs"), ["task:ap", "thread:ask"]);
  assert.deepEqual(ids("b", "failed"), ["task:f"]);
  assert.deepEqual(ids("b", "done"), ["thread:fin"]);
  assert.equal([...lanes.values()].flatMap((l) => Object.values(l).flat()).some((i) => i.key === "task:c"), false);
});

test("meters turn amber at 70 and red at 90; tokens flag two weeks out", () => {
  assert.deepEqual([loadTone(10), loadTone(70), loadTone(90)], ["ok", "need", "fail"]);
  const now = Date.parse("2026-10-16T00:00:00Z");
  assert.equal(tokenExpiring("2026-10-20T00:00:00Z", now), true);
  assert.equal(tokenExpiring("2027-01-01T00:00:00Z", now), false);
  assert.equal(tokenExpiring(null, now), false);
  assert.match(gb(2 ** 30 * 9.1), /9,1 GB/);
});
