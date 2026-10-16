import assert from "node:assert/strict";
import test from "node:test";
import { paginateCollection } from "./pagination.ts";

test("a live collection losing its last page still exposes its remaining rows", () => {
  const rows = Array.from({ length: 21 }, (_, id) => ({ id }));
  assert.deepEqual(paginateCollection(rows, 3, 10).items.map((r) => r.id), [20]);
  const reduced = paginateCollection(rows.slice(0, 11), 3, 10);
  assert.equal(reduced.page, 2);
  assert.deepEqual(reduced.items.map((r) => r.id), [10]);
  assert.deepEqual([reduced.start, reduced.end, reduced.total], [11, 11, 11]);
});

test("paging a filtered result neither repeats nor drops matching items", () => {
  const rows = Array.from({ length: 53 }, (_, id) => ({ id, machine: id % 2 ? "PC" : "VPS" }));
  const matching = rows.filter((r) => r.machine === "PC").toReversed();
  const pages = [1, 2, 3].flatMap((n) => paginateCollection(matching, n, 10).items);
  assert.deepEqual(pages, matching);
  assert.equal(new Set(pages.map((r) => r.id)).size, matching.length);
});

test("empty and invalid page requests remain finite and do not create phantom rows", () => {
  assert.deepEqual(paginateCollection([], Infinity, 0), { items: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 });
  assert.deepEqual(paginateCollection([1, 2], -1, 1).items, [1]);
});
