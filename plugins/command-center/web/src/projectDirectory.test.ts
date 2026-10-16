import assert from "node:assert/strict";
import test from "node:test";
import { moveProject, type ProjectSettings } from "../../server/settings.ts";
import { projectDirectory, type ProjectEntry, type ProjectFilters } from "./projectDirectory.ts";

const filters: ProjectFilters = { query: "", machineId: "", status: "all" };
const entries: ProjectEntry[] = Array.from({ length: 26 }, (_, i) => ({
  key: `m:${i}`, title: `Project ${String(i).padStart(2, "0")}`, path: `D:/work/repo-${i}`,
  machine: { machineId: i % 2 ? "remote" : "local", machineLabel: "Machine", status: i % 2 ? "offline" : "online", projects: [] },
  running: 0, needs: 0, queued: 0, active: "2026-01-01",
}));
const settings: ProjectSettings = {
  pinned: ["m:0", "m:1"], groups: [{ id: "g", name: "Group" }, { id: "empty", name: "Empty" }],
  groupOf: Object.fromEntries(entries.slice(2, 17).map((e) => [e.key, "g"])),
  order: entries.map((e) => e.key), collapsed: [], sort: "manual",
};

test("global pages span pinned, grouped and ungrouped projects exactly once", () => {
  const pages = [1, 2, 3].map((page) => projectDirectory(entries, settings, filters, page, 10));
  assert.deepEqual(pages.map((p) => p.pagination.items.length), [10, 10, 6]);
  assert.deepEqual(pages.flatMap((p) => p.pagination.items.map((r) => r.entry.key)), entries.map((e) => e.key));
  assert.deepEqual(pages[0]!.buckets.map((b) => b.id), ["pinned", "g", "empty", "other"]);
  assert.deepEqual(pages[1]!.buckets.map((b) => b.id), ["pinned", "g", "empty", "other"]);
  assert.equal(pages[1]!.buckets.find((b) => b.id === "g")!.rows[0]!.index, 8);
});

test("path/name, machine and online status filters compose without mutating original buckets", () => {
  const found = projectDirectory(entries, settings, { query: " REPO-1 ", machineId: "remote", status: "offline" }, 1, 10);
  assert.deepEqual(found.pagination.items.map((r) => r.entry.key), ["m:1", "m:11", "m:13", "m:15", "m:17", "m:19"]);
  assert.equal(found.buckets.find((b) => b.id === "g")!.rows[0]!.index, 9);
  assert.equal(projectDirectory(entries, settings, { ...filters, query: "PROJECT 25" }, 1, 10).pagination.total, 1);
  assert.equal(projectDirectory(entries, settings, { ...filters, machineId: "remote", status: "online" }, 1, 10).pagination.total, 0);
});

test("manual move on a later unfiltered page uses the full bucket's adjacent project", () => {
  const result = projectDirectory(entries, settings, filters, 2, 10);
  const bucket = result.buckets.find((b) => b.id === "g")!;
  const row = bucket.rows[0]!;
  const order = moveProject(settings.order, bucket.items.map((e) => e.key), row.entry.key, -1);
  const moved = projectDirectory(entries, { ...settings, order }, filters, 1, 50);
  assert.deepEqual(moved.pagination.items.slice(9, 11).map((r) => r.entry.key), ["m:10", "m:9"]);
});

test("unchanged SSE entries retain pages; shrinking collections clamp to remaining projects", () => {
  const before = projectDirectory(entries, settings, filters, 3, 10);
  const refresh = projectDirectory(entries.map((e) => ({ ...e, running: 1 })), settings, filters, 3, 10);
  assert.deepEqual(refresh.pagination.items.map((r) => r.entry.key), before.pagination.items.map((r) => r.entry.key));
  const reduced = projectDirectory(entries.slice(0, 11), settings, filters, 3, 10);
  assert.equal(reduced.pagination.page, 2);
  assert.equal(reduced.pagination.items[0]!.entry.key, "m:10");
});


test("collapsed groups consume no page slots and every header remains reachable", () => {
  const collapsed = { ...settings, collapsed: ["g"] };
  const pages = [1, 2].map((page) => projectDirectory(entries, collapsed, filters, page, 10));
  const remaining = entries.filter((e) => settings.groupOf[e.key] !== "g");
  assert.deepEqual(pages.map((p) => p.pagination.items.length), [10, 1]);
  assert.deepEqual(pages.flatMap((p) => p.pagination.items.map((r) => r.entry.key)), remaining.map((e) => e.key));
  for (const page of pages) {
    assert.equal(page.matchingTotal, 26);
    assert.equal(page.pagination.total, 11);
    assert.deepEqual(page.buckets.map((b) => b.id), ["pinned", "g", "empty", "other"]);
    const group = page.buckets.find((b) => b.id === "g")!;
    assert.equal(group.collapsed, true);
    assert.equal(group.matchingCount, 15);
    assert.deepEqual(group.rows, []);
  }
  const expanded = [1, 2, 3].map((page) => projectDirectory(entries, settings, filters, page, 10));
  assert.deepEqual(expanded.flatMap((p) => p.pagination.items.map((r) => r.entry.key)), entries.map((e) => e.key));
});

test("all matching projects can be collapsed without claiming no matches or shown rows", () => {
  const result = projectDirectory(entries, { ...settings, collapsed: ["g"] }, { ...filters, query: "repo-12" }, 8, 10);
  assert.equal(result.matchingTotal, 1);
  assert.equal(result.pagination.total, 0);
  assert.equal(result.pagination.items.length, 0);
  assert.equal(result.pagination.start, 0);
  assert.equal(result.pagination.end, 0);
  const group = result.buckets.find((b) => b.id === "g")!;
  assert.equal(group.matchingCount, 1);
  assert.equal(group.items.length, 15);
});

test("filtered header counts cover the full match set and manual moves require no filters", () => {
  const result = projectDirectory(entries, settings, { ...filters, query: "repo-1" }, 1, 2);
  const group = result.buckets.find((b) => b.id === "g")!;
  assert.equal(group.matchingCount, 7);
  assert.equal(group.items.length, 15);
  assert.equal(result.canMove, false);
  assert.equal(projectDirectory(entries, settings, filters, 2, 10).canMove, true);
  for (const patch of [{ machineId: "local" }, { status: "online" as const }, { query: "Project" }]) {
    assert.equal(projectDirectory(entries, settings, { ...filters, ...patch }, 1, 10).canMove, false);
  }
  assert.equal(projectDirectory(entries, { ...settings, sort: "name" }, filters, 1, 10).canMove, false);
});
