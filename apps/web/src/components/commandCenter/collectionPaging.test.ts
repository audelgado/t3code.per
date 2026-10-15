import { describe, expect, it } from "vite-plus/test";
import { paginateCollection, paginateKeepingRow, showLoadOlder } from "./collectionPaging";

describe("Command Center collection paging", () => {
  it("pages a large collection without omitting or repeating records", () => {
    const all = Array.from({ length: 1_003 }, (_, id) => ({ id }));
    const first = paginateCollection(all, 1, 25);
    const pages = Array.from({ length: first.pageCount }, (_, index) =>
      paginateCollection(all, index + 1, 25),
    );
    expect(pages.flatMap((page) => page.items)).toEqual(all);
    expect(pages.every((page) => page.items.length <= 25)).toBe(true);
    expect(pages.at(-1)).toMatchObject({ start: 1_001, end: 1_003, total: 1_003 });
  });

  it("clamps the page after deletion and handles an empty filtered collection", () => {
    expect(paginateCollection([1, 2, 3], 10, 2)).toMatchObject({
      items: [3],
      page: 2,
      start: 3,
      end: 3,
    });
    expect(paginateCollection([], 9, 25)).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      start: 0,
      end: 0,
      total: 0,
    });
  });

  it("normalizes invalid bounds without producing unbounded or empty pages", () => {
    expect(paginateCollection([1, 2], -5, 0)).toMatchObject({ items: [1], page: 1, pageCount: 2 });
    expect(paginateCollection([1, 2], NaN, Infinity)).toMatchObject({ items: [1], page: 1 });
  });

  it("offers Load older only on the last loaded page", () => {
    const loaded = Array.from({ length: 60 }, (_, id) => id);
    expect(showLoadOlder(paginateCollection(loaded, 1, 30), true)).toBe(false);
    expect(showLoadOlder(paginateCollection(loaded, 2, 30), true)).toBe(true);
    expect(showLoadOlder(paginateCollection(loaded, 2, 30), false)).toBe(false);
    expect(showLoadOlder(paginateCollection([], 1, 30), true)).toBe(true);
  });
});

describe("paginateKeepingRow", () => {
  const rows = Array.from({ length: 1000 }, (_, index) => ({ key: `waiting:${index}` }));
  const keyOf = (row: (typeof rows)[number]) => row.key;

  it("keeps the currently answered row reachable across pages without duplicating it", () => {
    const first = paginateKeepingRow(rows, 1, 5, "waiting:3", keyOf);
    const second = paginateKeepingRow(rows, 2, 5, "waiting:3", keyOf);
    expect(first.items).toHaveLength(5);
    expect(second.items).toHaveLength(6);
    expect(second.items.at(-1)).toBe(first.items[3]);
    expect(second.items.filter((row) => row.key === "waiting:3")).toHaveLength(1);
    expect(second.total).toBe(1000);
    expect(second.pageCount).toBe(200);
  });

  it("clamps live removals and stops keeping a row once it is gone", () => {
    const remaining = rows.slice(0, 4);
    const result = paginateKeepingRow(remaining, 50, 5, "waiting:999", keyOf);
    expect(result.items).toEqual(remaining);
    expect(result.page).toBe(1);
    expect(paginateKeepingRow(rows, 2, 5, null, keyOf).items).toHaveLength(5);
  });
});
