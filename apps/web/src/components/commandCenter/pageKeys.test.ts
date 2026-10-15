import { describe, expect, it } from "vite-plus/test";
import { resolvePageKey } from "./pageKeys";

describe("Command Center page shortcuts", () => {
  it("uses g chords within 1.5s and leaves digits for Home", () => {
    expect(resolvePageKey("g", 100, null, "home")).toEqual({ chordAt: 100 });
    expect(resolvePageKey("w", 1500, 100, "home")).toEqual({ chordAt: null, tab: "work" });
    expect(resolvePageKey("w", 1700, 100, "home")).toEqual({ chordAt: null });
    expect(resolvePageKey("1", 200, null, "home")).toEqual({ chordAt: null });
    expect(resolvePageKey("o", 200, 100, "home")).toEqual({ chordAt: null, tab: "workflows" });
  });
  it("opens Work with brackets elsewhere, leaving Work rotation to the tab", () => {
    expect(resolvePageKey("]", 200, null, "home")).toEqual({ chordAt: null, tab: "work" });
    expect(resolvePageKey("[", 200, null, "work")).toEqual({ chordAt: null });
  });
});
