import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  CommandCenterSectionId,
  EnvironmentId,
  ProjectId,
  type CommandCenterSection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterProjectDirectory,
  latestThreadByProject,
  pinnedFirst,
  type ProjectEntry,
  projectEntryKey,
  pruneProjectEntries,
  updateProjectEntries,
} from "./projectDirectory";

const TODAY = "2026-10-14";
const project = (id: string, patch: Partial<EnvironmentProject> = {}): EnvironmentProject => ({
  id: ProjectId.make(id),
  environmentId: EnvironmentId.make("local"),
  title: id,
  workspaceRoot: `/projects/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});
const section = (id: string, patch: Partial<CommandCenterSection> = {}): CommandCenterSection => ({
  id: CommandCenterSectionId.make(id),
  projectId: ProjectId.make(id),
  name: id,
  status: "todo",
  tasksDone: 0,
  tasksTotal: 10,
  dueDate: null,
  trying: null,
  blocker: null,
  missing: [],
  dependsOn: [],
  sortKey: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});
const select = (patch: Partial<Parameters<typeof filterProjectDirectory>[0]> = {}) =>
  filterProjectDirectory({
    projects: [],
    sectionsByProject: new Map(),
    query: "",
    environmentId: null,
    status: "all",
    sort: "name",
    today: TODAY,
    ...patch,
  });
const ids = (projects: ReadonlyArray<EnvironmentProject>) => projects.map(({ id }) => id);

describe("project directory", () => {
  it("uses manual order after pins, keeps unknown keys last and leaves name sort unchanged", () => {
    const projects = [project("alpha"), project("beta"), project("gamma"), project("pinned")];
    const pinned = projects[3]!;
    const entries = new Map([
      [
        projectEntryKey(pinned),
        { key: projectEntryKey(pinned), pinned: true, groupId: null, url: null },
      ],
    ]);
    const order = [projectEntryKey(projects[2]!), projectEntryKey(projects[0]!)];
    expect(ids(select({ projects, entries, order, sort: "manual" }))).toEqual([
      "pinned",
      "gamma",
      "alpha",
      "beta",
    ]);
    expect(ids(select({ projects, entries, order, sort: "name" }))).toEqual([
      "pinned",
      "alpha",
      "beta",
      "gamma",
    ]);
  });
  it("combines title/path search and environment before pagination", () => {
    const projects = Array.from({ length: 25 }, (_, index) => project(`project-${index}`));
    const selected = project("selected", {
      title: "Misión",
      workspaceRoot: "D:/Código/Especial",
      environmentId: EnvironmentId.make("remote"),
    });
    projects.push(selected);
    expect(
      select({
        projects,
        query: " MISION ",
        environmentId: "remote",
      }),
    ).toEqual([selected]);
    expect(select({ projects, query: "codigo/especial" })).toEqual([selected]);
    expect(select({ projects, query: "mision", environmentId: "local" })).toEqual([]);
  });

  it("distinguishes untracked, active, attention and completed projects", () => {
    const projects = ["untracked", "active", "blocked", "near", "complete"].map((id) =>
      project(id),
    );
    const sectionsByProject = new Map(
      projects.slice(1).map(({ id }) => [
        id,
        [
          section(id, {
            status: id === "blocked" ? "blocked" : id === "complete" ? "done" : "todo",
            dueDate: id === "near" ? "2026-10-19" : null,
          }),
        ],
      ]),
    );
    expect(ids(select({ projects, sectionsByProject, status: "untracked" }))).toEqual([
      "untracked",
    ]);
    expect(ids(select({ projects, sectionsByProject, status: "active" }))).toEqual([
      "active",
      "blocked",
      "near",
    ]);
    expect(ids(select({ projects, sectionsByProject, status: "attention" }))).toEqual([
      "blocked",
      "near",
    ]);
    expect(ids(select({ projects, sectionsByProject, status: "complete" }))).toEqual(["complete"]);
  });

  it("ranks red before amber before green and respects agents and cross-project dependencies", () => {
    const projects = ["a-green", "b-working", "c-waiting", "z-red"].map((id) => project(id));
    const sectionsByProject = new Map(
      projects.map(({ id }) => [
        id,
        [
          section(id, {
            status: id === "z-red" ? "blocked" : id === "b-working" ? "in_progress" : "todo",
            dependsOn: id === "c-waiting" ? [CommandCenterSectionId.make("z-red")] : [],
          }),
        ],
      ]),
    );
    const activeAgentCounts = new Map([[ProjectId.make("b-working"), 1]]);
    expect(
      ids(select({ projects, sectionsByProject, activeAgentCounts, sort: "attention" })),
    ).toEqual(["z-red", "c-waiting", "a-green", "b-working"]);
    expect(
      ids(select({ projects, sectionsByProject, activeAgentCounts, status: "attention" })),
    ).toEqual(["c-waiting", "z-red"]);
  });

  it("orders open upcoming deliveries with undated projects last and deterministic ties", () => {
    const projects = [
      project("z-undated"),
      project("later"),
      project("soon"),
      project("same-b", { title: "Same", environmentId: EnvironmentId.make("remote") }),
      project("same-a", { title: "Same" }),
    ];
    const sectionsByProject = new Map([
      [ProjectId.make("soon"), [section("soon", { dueDate: TODAY })]],
      [ProjectId.make("later"), [section("later", { dueDate: "2026-10-20" })]],
    ]);
    expect(ids(select({ projects, sectionsByProject, sort: "delivery" }))).toEqual([
      "soon",
      "later",
      "same-a",
      "same-b",
      "z-undated",
    ]);
    expect(
      ids(select({ projects: projects.toReversed(), sectionsByProject, sort: "delivery" })),
    ).toEqual(["soon", "later", "same-a", "same-b", "z-undated"]);
    expect(
      ids(select({ projects: [project("b", { title: "Same" }), project("a", { title: "Same" })] })),
    ).toEqual(["a", "b"]);
  });

  it("orders pinned projects first, then by latest activity, and filters by group", () => {
    const projects = ["quiet", "busy", "pinned-old", "grouped"].map((id) => project(id));
    const entry = (id: string, patch: Partial<ProjectEntry>): [string, ProjectEntry] => {
      const key = projectEntryKey(project(id));
      return [key, { key, pinned: false, groupId: null, url: null, ...patch }];
    };
    const entries = new Map([
      entry("pinned-old", { pinned: true }),
      entry("grouped", { groupId: "clients" }),
      entry("busy", { groupId: "clients" }),
    ]);
    const activity = new Map([
      [projectEntryKey(project("busy")), { at: 300 }],
      [projectEntryKey(project("grouped")), { at: 200 }],
      [projectEntryKey(project("pinned-old")), { at: 100 }],
    ]);
    expect(ids(select({ projects, entries, activity, sort: "activity" }))).toEqual([
      "pinned-old",
      "busy",
      "grouped",
      "quiet",
    ]);
    expect(ids(select({ projects, entries, activity, sort: "name" }))).toEqual([
      "pinned-old",
      "busy",
      "grouped",
      "quiet",
    ]);
    expect(ids(select({ projects, entries, activity, groupId: "clients" }))).toEqual([
      "busy",
      "grouped",
    ]);
    expect(ids(select({ projects, entries, groupId: "deleted" }))).toEqual([]);
  });

  it("keeps clones of one repository as separate rows", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/acme/app",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:acme/app.git",
      },
    };
    const local = project("app", { repositoryIdentity });
    const remote = project("app-vps", {
      title: "app",
      workspaceRoot: "/projects/app",
      environmentId: EnvironmentId.make("vps"),
      repositoryIdentity,
    });
    expect(select({ projects: [local, remote] })).toEqual([local, remote]);
    expect(projectEntryKey(local)).not.toBe(projectEntryKey(remote));
  });
});

describe("project launcher entries", () => {
  it("creates, updates and drops entries that return to their defaults", () => {
    const pinned = updateProjectEntries([], ["local:a", "local:b"], { pinned: true });
    expect(pinned).toEqual([
      { key: "local:a", pinned: true, groupId: null, url: null },
      { key: "local:b", pinned: true, groupId: null, url: null },
    ]);
    const grouped = updateProjectEntries(pinned, ["local:b", "local:c"], { groupId: "g" });
    expect(grouped).toEqual([
      { key: "local:a", pinned: true, groupId: null, url: null },
      { key: "local:b", pinned: true, groupId: "g", url: null },
      { key: "local:c", pinned: false, groupId: "g", url: null },
    ]);
    // Removing from a group keeps the pin; an entry with nothing left is not saved.
    expect(updateProjectEntries(grouped, ["local:b", "local:c"], { groupId: null })).toEqual([
      { key: "local:a", pinned: true, groupId: null, url: null },
      { key: "local:b", pinned: true, groupId: null, url: null },
    ]);
  });

  it("lists pinned projects first in pickers without reordering the rest", () => {
    const projects = ["a", "b", "c", "d"].map((id) => project(id));
    const entries = updateProjectEntries([], [projectEntryKey(project("c"))], { pinned: true });
    expect(ids(pinnedFirst(projects, entries))).toEqual(["c", "a", "b", "d"]);
    expect(ids(pinnedFirst(projects, []))).toEqual(["a", "b", "c", "d"]);
  });

  it("finds each project's latest sidebar thread on its own machine", () => {
    const shell = (
      id: string,
      projectId: string,
      updatedAt: string,
      patch: {
        environmentId?: string;
        archivedAt?: string | null;
        relationshipToParent?: "subagent" | "fork" | null;
      } = {},
    ) => ({
      id,
      projectId: ProjectId.make(projectId),
      environmentId: EnvironmentId.make(patch.environmentId ?? "local"),
      archivedAt: patch.archivedAt ?? null,
      lineage: { relationshipToParent: patch.relationshipToParent ?? null },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt,
      latestUserMessageAt: null,
    });
    const latest = latestThreadByProject([
      shell("old", "app", "2026-10-02T00:00:00.000Z"),
      shell("new", "app", "2026-10-05T00:00:00.000Z"),
      shell("archived", "app", "2026-10-09T00:00:00.000Z", { archivedAt: "2026-10-09" }),
      shell("scout", "app", "2026-10-10T00:00:00.000Z", { relationshipToParent: "subagent" }),
      shell("vps", "app", "2026-10-08T00:00:00.000Z", { environmentId: "vps" }),
    ]);
    expect(latest.get("local:app")?.shell.id).toBe("new");
    expect(latest.get("vps:app")?.shell.id).toBe("vps");
  });

  it("prunes entries of removed projects only on machines whose projects are known", () => {
    const entries = updateProjectEntries([], ["local:kept", "local:removed", "vps:offline"], {
      pinned: true,
    });
    expect(
      pruneProjectEntries(entries, [project("kept")], new Set(["local"])).map(({ key }) => key),
    ).toEqual(["local:kept", "vps:offline"]);
  });
});
