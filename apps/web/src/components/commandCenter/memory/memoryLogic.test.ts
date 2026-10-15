import {
  CommandCenterMemoryId,
  ProjectId,
  type CommandCenterMemoryEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupMemoryByDay,
  mergeMemoryPages,
  nextMemoryCursor,
  selectMemoryPage,
} from "./memoryLogic";

function entry(id: string, createdAt: string, extra: Partial<CommandCenterMemoryEntry> = {}) {
  return {
    id: CommandCenterMemoryId.make(id),
    projectId: null,
    sectionId: null,
    threadId: null,
    kind: "note",
    text: `entry ${id}`,
    done: false,
    source: "user",
    createdAt,
    updatedAt: createdAt,
    ...extra,
  } satisfies CommandCenterMemoryEntry;
}

const all = { project: "all", kind: "all", search: "" } as const;

describe("groupMemoryByDay", () => {
  it("groups by local day, newest first", () => {
    const days = groupMemoryByDay(
      [
        entry("a", new Date(2026, 9, 1, 9).toISOString()),
        entry("b", new Date(2026, 9, 2, 9).toISOString()),
        entry("c", new Date(2026, 9, 1, 18).toISOString()),
      ],
      all,
    );
    expect(days.map((day) => [day.day, day.entries.map((item) => item.id)])).toEqual([
      ["2026-10-02", ["b"]],
      ["2026-10-01", ["c", "a"]],
    ]);
  });

  it("applies project, kind and search filters together", () => {
    const at = new Date(2026, 9, 1, 9).toISOString();
    const entries = [
      entry("a", at, { projectId: ProjectId.make("p1"), kind: "todo", text: "Ship the API" }),
      entry("b", at, { projectId: ProjectId.make("p1"), kind: "note", text: "ship notes" }),
      entry("c", at, { kind: "todo", text: "Ship docs" }),
    ];
    const ids = (filter: Parameters<typeof groupMemoryByDay>[1]) =>
      groupMemoryByDay(entries, filter).flatMap((day) => day.entries.map((item) => item.id));
    expect(ids({ project: ProjectId.make("p1"), kind: "todo", search: "SHIP" })).toEqual(["a"]);
    expect(ids({ project: "none", kind: "all", search: "" })).toEqual(["c"]);
    expect(ids({ ...all, search: "notes" })).toEqual(["b"]);
  });
});

describe("memory paging", () => {
  const iso = (day: number) => new Date(2026, 9, day, 9).toISOString();

  it("bounds large timelines without losing chronology or splitting day labels incorrectly", () => {
    const entries = Array.from({ length: 107 }, (_, index) =>
      entry(`n${index}`, new Date(2026, 9, 1, 0, index).toISOString()),
    );
    const days = groupMemoryByDay(entries, all);
    const pages = Array.from({ length: 5 }, (_, index) => selectMemoryPage(days, index + 1));
    expect(pages.flatMap((page) => page.days.flatMap((day) => day.entries))).toEqual(
      entries.toReversed(),
    );
    expect(pages.every((page) => page.days.flatMap((day) => day.entries).length <= 25)).toBe(true);
    expect(pages[1]?.days[0]?.day).toBe("2026-10-01");
  });

  it("returns a usable page after narrowing search or deleting the last entry", () => {
    const days = groupMemoryByDay([entry("a", iso(5)), entry("b", iso(4))], {
      ...all,
      search: "entry a",
    });
    expect(selectMemoryPage(days, 8)).toMatchObject({ page: 1, total: 1, start: 1, end: 1 });
    expect(selectMemoryPage([], 8)).toMatchObject({
      page: 1,
      total: 0,
      start: 0,
      end: 0,
      days: [],
    });
  });

  it("merges older pages without duplicating live entries", () => {
    const live = entry("a", iso(5), { text: "live" });
    const merged = mergeMemoryPages(
      [live],
      [entry("a", iso(5), { text: "stale" }), entry("b", iso(1))],
    );
    expect(merged.map((item) => [item.id, item.text])).toEqual([
      ["a", "live"],
      ["b", "entry b"],
    ]);
  });

  it("pages from the last older entry, else the oldest snapshot entry that is not a todo", () => {
    const snapshot = [
      entry("old-todo", iso(1), { kind: "todo" }),
      entry("n2", iso(4)),
      entry("n1", iso(3)),
    ];
    expect(nextMemoryCursor(snapshot, [])).toEqual({ before: "n1", beforeCreatedAt: iso(3) });
    expect(nextMemoryCursor(snapshot, [entry("p1", iso(2)), entry("p0", iso(1))])?.before).toBe(
      "p0",
    );
    expect(nextMemoryCursor([], [])).toBeUndefined();
  });

  it("does not page from an old todo closed after the snapshot loaded", () => {
    const snapshot = [
      entry("closed-todo", iso(1), { kind: "todo", done: true }),
      entry("n1", iso(3)),
    ];
    expect(nextMemoryCursor(snapshot, [])?.before).toBe("n1");
  });
});
