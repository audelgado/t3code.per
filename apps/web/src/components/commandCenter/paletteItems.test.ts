import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { commandCenterPaletteEntries, PALETTE_PINNED_LIMIT } from "./paletteItems";

const local = EnvironmentId.make("local");
const project = (id: string) => ({
  environmentId: local,
  id: ProjectId.make(id),
  title: `Project ${id}`,
  workspaceRoot: `/work/${id}`,
});

describe("Command Center palette entries", () => {
  it("lists visible tabs, valid quick actions and pinned projects in pin order", () => {
    const entries = commandCenterPaletteEntries({
      settings: {
        sections: [
          { id: "home", label: "", visible: true },
          { id: "finance", label: "Money", visible: true },
          { id: "team", label: "", visible: false },
        ],
        quickActions: [
          { id: "q1", label: "Usage", kind: "link", target: "/usage" },
          { id: "q2", label: "Broken", kind: "link", target: "//evil.com" },
        ],
        projects: [
          { key: "local:b", pinned: true, groupId: null, url: null },
          { key: "local:a", pinned: false, groupId: "g", url: null },
          { key: "local:gone", pinned: true, groupId: null, url: null },
          { key: "local:a2", pinned: true, groupId: null, url: null },
        ],
      },
      projects: [project("a"), project("a2"), project("b")],
    });
    const tabs = entries.flatMap((entry) => (entry.kind === "tab" ? [entry.tab] : []));
    expect(tabs).not.toContain("team");
    expect(tabs.slice(0, 3)).toEqual(["home", "work", "finance"]);
    expect(entries.find((entry) => entry.kind === "tab" && entry.tab === "finance")?.title).toBe(
      "Command Center: Money",
    );
    expect(entries.filter((entry) => entry.kind === "tab" && entry.isDefault)).toHaveLength(1);
    expect(
      entries.flatMap((entry) => (entry.kind === "quickAction" ? [entry.action.id] : [])),
    ).toEqual(["q1"]);
    expect(entries.flatMap((entry) => (entry.kind === "project" ? [entry.projectId] : []))).toEqual(
      ["b", "a2"],
    );
  });

  it("stays within 9 tabs, 20 quick actions and 8 pinned projects", () => {
    const projects = Array.from({ length: 12 }, (_, index) => project(`p${index}`));
    const entries = commandCenterPaletteEntries({
      settings: {
        sections: [],
        quickActions: Array.from({ length: 20 }, (_, index) => ({
          id: `q${index}`,
          label: `Action ${index}`,
          kind: "prompt" as const,
          target: "Review",
        })),
        projects: projects.map((item) => ({
          key: `local:${item.id}`,
          pinned: true,
          groupId: null,
          url: null,
        })),
      },
      projects,
    });
    expect(entries.filter((entry) => entry.kind === "project")).toHaveLength(PALETTE_PINNED_LIMIT);
    expect(entries.length).toBeLessThanOrEqual(9 + 1 + 20 + 8);
    expect(entries.filter((entry) => entry.kind === "tab")).toHaveLength(9);
  });
  it("offers a focused new work action on its own environment and a tidy entry", () => {
    const entries = commandCenterPaletteEntries({
      settings: { sections: [], quickActions: [], projects: [] },
      projects: [project("a")],
      focusProjectId: ProjectId.make("a"),
    });
    expect(entries.find((entry) => entry.kind === "newWork")).toMatchObject({
      projectId: "a",
      environmentId: local,
    });
    expect(entries.filter((entry) => entry.kind === "tidy")).toHaveLength(1);
    expect(
      commandCenterPaletteEntries({
        settings: { sections: [], quickActions: [], projects: [] },
        projects: [],
      }).some((entry) => entry.kind === "newWork"),
    ).toBe(false);
  });
});
