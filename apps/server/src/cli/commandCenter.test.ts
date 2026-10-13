import { describe, expect, it } from "@effect/vitest";
import {
  type CommandCenterArtifact,
  type CommandCenterArtifactDetail,
  CommandCenterArtifactId,
  ProjectId,
  type ProjectSnapshot,
} from "@t3tools/contracts";

import { findProject, formatArtifactLine, formatArtifactVersions } from "./commandCenter.ts";

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

const artifact: CommandCenterArtifact = {
  id: CommandCenterArtifactId.make("art-1"),
  projectId: null,
  title: "Launch plan",
  kind: "html",
  currentVersion: 2,
  sourceThreadId: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-12T10:30:00.000Z",
  archivedAt: null,
};

const version = (number: number, authorLabel: string | null) => ({
  artifactId: artifact.id,
  version: number,
  author: "agent" as const,
  authorLabel,
  threadId: null,
  attachmentId: `cc-artifact-${number}-html`,
  sizeBytes: 100 * number,
  createdAt: `2026-10-1${number}T08:15:00.000Z`,
});

describe("artifact lines", () => {
  it("prints id, day, kind, version and title, and flags archived ones", () => {
    expect(formatArtifactLine(artifact)).toBe("art-1  2026-10-12  html     v2  Launch plan");
    expect(formatArtifactLine({ ...artifact, archivedAt: "2026-10-13T00:00:00.000Z" })).toMatch(
      /Launch plan {2}archived$/,
    );
  });

  it("marks the version being shown and falls back to the author kind", () => {
    const detail: CommandCenterArtifactDetail = {
      artifact,
      version: version(1, null),
      content: "<p>hi</p>",
      versions: [version(2, "codex"), version(1, null)],
    };
    expect(formatArtifactVersions(detail)).toEqual([
      "  v2  2026-10-12 08:15  codex  200 B",
      "* v1  2026-10-11 08:15  agent  100 B",
    ]);
  });
});
