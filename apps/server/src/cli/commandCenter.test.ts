import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type ProjectSnapshot } from "@t3tools/contracts";

import { findProject } from "./commandCenter.ts";

type ProjectShell = ProjectSnapshot["projects"][number];

const shell = (id: string, title: string, workspaceRoot: string, deleted = false) =>
  ({
    id: ProjectId.make(id),
    title,
    workspaceRoot,
    deletedAt: deleted ? "2026-01-01T00:00:00.000Z" : null,
  }) as ProjectShell;

const projects = [
  shell("p-gone", "Acme", "/work/acme", true),
  shell("p-acme", "Acme", "/work/acme"),
  shell("p-site", "Marketing Site", "/work/site"),
];
const resolvePath = (input: string) => (input.startsWith("/") ? input : `/work/${input}`);

describe("findProject", () => {
  it("matches by id, then workspace root, then title in any case, skipping deleted projects", () => {
    expect(findProject(projects, "p-site", resolvePath)?.id).toBe("p-site");
    expect(findProject(projects, "acme", resolvePath)?.id).toBe("p-acme");
    expect(findProject(projects, " marketing site ", resolvePath)?.id).toBe("p-site");
    expect(findProject(projects, "p-gone", resolvePath)).toBeUndefined();
  });
});
