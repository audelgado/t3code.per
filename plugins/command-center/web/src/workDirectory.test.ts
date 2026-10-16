import assert from "node:assert/strict";
import test from "node:test";
import type { WorkMachine, WorkRow } from "../../server/work.ts";
import { paginateCollection } from "./pagination.ts";
import { workDirectory, type WorkFilters } from "./workDirectory.ts";

const filters: WorkFilters = { query: "", machineId: "", status: "all" };
const row = (i: number): WorkRow => ({
  key: `r${i}`, title: `Task ${i}`, branch: `feature/${i}`, worktreePath: null, threadCount: 1, taskId: null,
  agent: i === 0 ? "working" : i === 1 ? "needs-you" : "idle", stage: 1, blocked: null,
  tidy: i === 2 ? "stale" : null, changedFiles: null, ahead: null, behind: null,
  pr: i === 4 ? { number: 42, url: "https://example.com/pr/42", state: "open", isDraft: false } : null, note: i === 3 ? "Status unavailable" : null, updatedAt: "2026-01-01", appUrl: "#", webUrl: null,
});
const machines: WorkMachine[] = [
  { id: "a", label: "Local", status: "online", lanes: Array.from({ length: 7 }, (_, i) => ({ projectId: `p${i}`, title: `Project ${i}`, rows: Array.from({ length: 12 }, (_, j) => row(j)) })) },
  { id: "b", label: "Remote", status: "offline", lanes: [{ projectId: "p0", title: "Remote repo", rows: [row(0)] }] },
];

test("lane pages are global across machines and branches remain bounded independently", () => {
  const first = workDirectory(machines, filters, 1);
  const second = workDirectory(machines, filters, 2);
  assert.equal(first.pagination.items.length, 5);
  assert.equal(second.pagination.items.length, 3);
  assert.deepEqual(second.pagination.items.map((x) => `${x.machine.id}:${x.lane.projectId}`), ["a:p5", "a:p6", "b:p0"]);
  const rows = first.pagination.items[0]!.rows;
  assert.deepEqual([1, 2, 3].flatMap((p) => paginateCollection(rows, p, 5).items), rows);
  assert.equal(paginateCollection(rows, 1, 5).items.length, 5);
});

test("search matches task name, project or branch and combines with machine and status", () => {
  assert.equal(workDirectory(machines, { ...filters, query: "PROJECT 3" }, 1).pagination.total, 1);
  assert.deepEqual(workDirectory(machines, { ...filters, query: " task 2 ", status: "tidy" }, 1).pagination.items[0]!.rows.map((r) => r.key), ["r2"]);
  assert.deepEqual(workDirectory(machines, { ...filters, query: "feature/1", status: "active" }, 1).pagination.items[0]!.rows.map((r) => r.key), ["r1"]);
  const remote = workDirectory(machines, { ...filters, machineId: "b" }, 1);
  assert.equal(remote.pagination.total, 1);
  assert.equal(remote.machines[0]!.status, "offline");
  assert.deepEqual(workDirectory(machines, { ...filters, status: "pr" }, 1).pagination.items[0]!.rows.map((r) => r.key), ["r4"]);
});

test("filters keep original lane rows for tidy scope and partial status notes remain visible", () => {
  const result = workDirectory(machines, { ...filters, status: "active" }, 1).pagination.items[0]!;
  assert.equal(result.rows.length, 2);
  assert.equal(result.lane.rows.filter((r) => r.tidy).length, 1);
  const all = workDirectory(machines, filters, 1).pagination.items[0]!;
  assert.equal(all.rows[3]!.note, "Status unavailable");
  assert.equal(machines[0]!.lanes[0]!.rows.length, 12);
});

test("refresh keeps page and shrinking lanes clamp without hiding offline machines", () => {
  assert.deepEqual(workDirectory(structuredClone(machines), filters, 2).pagination.items, workDirectory(machines, filters, 2).pagination.items);
  const reduced = workDirectory([machines[1]!], filters, 2);
  assert.equal(reduced.pagination.page, 1);
  assert.equal(reduced.pagination.items[0]!.machine.id, "b");
  const unmatched = workDirectory(machines, { ...filters, query: "missing" }, 9);
  assert.equal(unmatched.pagination.page, 1);
  assert.equal(unmatched.machines.some((m) => m.status === "offline"), true);
});
