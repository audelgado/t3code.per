import { describe, expect, it } from "vite-plus/test";

import { compareManual, moveProject } from "./projectOrder";

describe("project manual order", () => {
  it("keeps unknown projects after known projects in their input order", () => {
    expect(["new-b", "a", "new-a", "b"].sort(compareManual(["b", "a", "b"]))).toEqual([
      "b",
      "a",
      "new-b",
      "new-a",
    ]);
  });

  it("materializes the list on first use and respects both edges", () => {
    expect(moveProject([], ["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveProject([], ["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveProject([], ["a", "b"], "b", 1)).toEqual(["a", "b"]);
    expect(moveProject([], ["a", "b"], "missing", 1)).toEqual(["a", "b"]);
  });

  it("preserves hidden projects, deduplicates and moves only visible neighbors", () => {
    expect(moveProject(["gone", "b", "b", "a"], ["a", "b", "c", "c"], "a", 1)).toEqual([
      "gone",
      "b",
      "c",
      "a",
    ]);
    expect(moveProject(["a", "hidden", "b", "other"], ["a", "b"], "a", 1)).toEqual([
      "b",
      "hidden",
      "a",
      "other",
    ]);
  });

  it("caps persisted order at 200 projects", () => {
    const keys = Array.from({ length: 205 }, (_, index) => String(index));
    const ordered = moveProject([], keys, "200", -1);
    expect(ordered).toHaveLength(200);
    expect(ordered[199]).toBe("200");
  });
});
