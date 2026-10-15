import { describe, expect, it } from "vite-plus/test";

import { searchLibrary } from "./libraryLogic";

describe("library directory", () => {
  const rows = [
    { title: "Ship", slug: "release", description: null },
    { title: "Audit", slug: "review", description: "Validate remote projects" },
  ];
  const fields = (row: (typeof rows)[number]) => [row.title, row.slug, row.description];

  it("searches descriptions and identifiers without mutating the source order", () => {
    expect(searchLibrary(rows, " REMOTE ", fields)).toEqual([rows[1]]);
    expect(searchLibrary(rows, "release", fields)).toEqual([rows[0]]);
    expect(searchLibrary(rows, "", fields)).toEqual([rows[1], rows[0]]);
    expect(rows[0]?.title).toBe("Ship");
  });

  it("returns an empty directory for unmatched queries and accepts missing descriptions", () => {
    expect(searchLibrary(rows, "unknown", fields)).toEqual([]);
    expect(searchLibrary([], "", fields)).toEqual([]);
  });
});
