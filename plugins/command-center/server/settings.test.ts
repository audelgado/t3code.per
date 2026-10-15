import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { compareManual, loadSettings, moveProject, normalizeSettings, saveSettings } from "./settings.ts";

test("imports a fork-shaped settings object", () => {
  const s = normalizeSettings({
    enabled: true,
    projectGroups: [{ id: "g1", name: " Work " }, { id: "g1", name: "dup" }, { id: "", name: "x" }],
    projects: [
      { key: "env1:p1", pinned: true, groupId: "g1", url: null },
      { key: "env1:p2", pinned: false, groupId: "gone", url: null },
    ],
    projectOrder: ["env1:p2", "env1:p1", "env1:p2"],
    sections: [{ id: "home" }],
  });
  assert.deepEqual(s.groups, [{ id: "g1", name: "Work" }]);
  assert.deepEqual(s.pinned, ["env1:p1"]);
  assert.deepEqual(s.groupOf, { "env1:p1": "g1" });
  assert.deepEqual(s.order, ["env1:p2", "env1:p1"]);
  assert.equal(s.sort, "activity");
  assert.deepEqual(s.sections, [{ id: "home" }]); // unknown keys survive
});

test("rejects junk and drops dangling references", () => {
  const s = normalizeSettings({ groups: [{ id: "g", name: "G" }], collapsed: ["g", "nope"], sort: "bogus", pinned: [1, "a", "a"], groupOf: { a: "nope" } });
  assert.deepEqual(s.collapsed, ["g"]);
  assert.equal(s.sort, "activity");
  assert.deepEqual(s.pinned, ["a"]);
  assert.deepEqual(s.groupOf, {});
  assert.deepEqual(normalizeSettings("junk").groups, []);
});

test("save then load round-trips and normalizes", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table kv(k text primary key, v text not null)");
  assert.equal(loadSettings(db).sort, "activity");
  saveSettings(db, { pinned: ["a:b"], sort: "name", extra: 1 });
  const s = loadSettings(db);
  assert.deepEqual([s.pinned, s.sort, s.extra], [["a:b"], "name", 1]);
});

test("keeps unknown projects after known ones in input order", () => {
  assert.deepEqual(["new-b", "a", "new-a", "b"].sort(compareManual(["b", "a", "b"])), ["b", "a", "new-b", "new-a"]);
});

test("moveProject materializes the list and respects edges", () => {
  assert.deepEqual(moveProject([], ["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(moveProject([], ["a", "b"], "a", -1), ["a", "b"]);
  assert.deepEqual(moveProject([], ["a", "b"], "b", 1), ["a", "b"]);
  assert.deepEqual(moveProject([], ["a", "b"], "missing", 1), ["a", "b"]);
});

test("moveProject preserves hidden projects and dedupes", () => {
  assert.deepEqual(moveProject(["gone", "b", "b", "a"], ["a", "b", "c", "c"], "a", 1), ["gone", "b", "c", "a"]);
  assert.deepEqual(moveProject(["a", "hidden", "b", "other"], ["a", "b"], "a", 1), ["b", "hidden", "a", "other"]);
});

test("moveProject caps order at 200", () => {
  const keys = Array.from({ length: 205 }, (_, i) => String(i));
  const o = moveProject([], keys, "200", -1);
  assert.equal(o.length, 200);
  assert.equal(o[199], "200");
});
