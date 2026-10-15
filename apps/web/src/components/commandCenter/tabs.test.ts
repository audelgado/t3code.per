import { describe, expect, it } from "vite-plus/test";
import { parseCommandCenterSearch } from "./tabs";

describe("Command Center search params", () => {
  it("keeps the project focus on every tab", () => {
    for (const tab of ["home", "work", "team", "canvas", "finance"]) {
      expect(parseCommandCenterSearch({ tab, project: " p1 " })).toEqual({ tab, project: "p1" });
    }
    expect(parseCommandCenterSearch({ project: "p1" })).toEqual({ project: "p1" });
  });

  it("keeps a run only on Workflows with a project, and an artifact only on Artifacts", () => {
    expect(parseCommandCenterSearch({ tab: "workflows", project: "p1", run: "r1" })).toEqual({
      tab: "workflows",
      project: "p1",
      run: "r1",
    });
    expect(parseCommandCenterSearch({ tab: "workflows", run: "r1" })).toEqual({
      tab: "workflows",
    });
    expect(parseCommandCenterSearch({ tab: "canvas", project: "p1", run: "r1" })).toEqual({
      tab: "canvas",
      project: "p1",
    });
    expect(parseCommandCenterSearch({ tab: "home", artifact: "a1" })).toEqual({ tab: "home" });
    expect(parseCommandCenterSearch({ tab: "artifacts", artifact: "a1" })).toEqual({
      tab: "artifacts",
      artifact: "a1",
    });
  });

  it("drops unknown tabs and blank or non-text values", () => {
    expect(parseCommandCenterSearch({ tab: "nope", project: "  ", ask: 3 })).toEqual({});
    expect(parseCommandCenterSearch({ ask: " Review the release " })).toEqual({
      ask: "Review the release",
    });
  });
});
