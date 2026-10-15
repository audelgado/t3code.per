import { CommandCenterSectionId, ProjectId, type CommandCenterSection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectSectionPage } from "./sectionDirectory";

const sections = Array.from({ length: 103 }, (_, index): CommandCenterSection => ({
  id: CommandCenterSectionId.make(`section-${index}`),
  projectId: ProjectId.make("p"),
  name: `Section ${index}`,
  status: index % 2 === 0 ? "blocked" : "todo",
  tasksDone: 0,
  tasksTotal: 1,
  dueDate: null,
  trying: null,
  blocker: index === 40 ? "API unavailable" : null,
  missing: [],
  dependsOn: [],
  sortKey: index,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
}));
const select = (patch: Partial<Parameters<typeof selectSectionPage>[0]> = {}) =>
  selectSectionPage({ sections, search: "", status: "all", page: 1, editing: null, ...patch });

describe("section directory", () => {
  it("pages a large project without dropping sections", () => {
    const pages = Array.from({ length: 11 }, (_, index) => select({ page: index + 1 }));
    expect(pages.flatMap((page) => page.visible)).toEqual(sections);
    expect(pages.every((page) => page.visible.length <= 10)).toBe(true);
  });
  it("searches blockers and combines status filters", () => {
    expect(select({ search: " API ", status: "blocked" }).visible).toEqual([sections[40]]);
    expect(select({ search: "API", status: "todo" }).total).toBe(0);
  });
  it("keeps the edited section on its page as live ordering changes", () => {
    const edited = sections[40]!;
    const result = select({ page: 1, editing: edited.id });
    expect(result.page).toBe(5);
    expect(result.visible).toContain(edited);
  });
  it("pins an active form when its section no longer matches filters", () => {
    const edited = sections[41]!;
    const result = select({ search: "API", editing: edited.id });
    expect(result.visible).toEqual([edited, sections[40]]);
    expect(result.total).toBe(1);
  });
  it("clamps the page after live deletions and releases a deleted edit", () => {
    const result = select({ sections: sections.slice(0, 3), page: 11, editing: sections[40]!.id });
    expect(result.page).toBe(1);
    expect(result.visible).toEqual(sections.slice(0, 3));
  });
});
