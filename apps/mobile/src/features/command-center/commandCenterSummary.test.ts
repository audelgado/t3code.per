import { threadShellKey } from "@t3tools/client-runtime/state/commandCenterDerive";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  CommandCenterArtifact,
  CommandCenterSection,
  CommandCenterSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { artifactDetail, sectionPullRequest, summarizeCommandCenter } from "./commandCenterSummary";

const home = "home" as EnvironmentId;
const vps = "vps" as EnvironmentId;
const now = new Date(2026, 9, 13, 12, 0).getTime();

const snapshot = {
  teams: [{ id: "remote", environmentId: vps, archivedAt: null }],
  agentProfiles: [
    { id: "a1", name: "Asker", teamId: "remote", sortKey: 0, archivedAt: null },
    { id: "a2", name: "Loner", teamId: null, sortKey: 1, archivedAt: null },
    { id: "gone", name: "Gone", teamId: null, sortKey: 2, archivedAt: "2026-01-01" },
  ],
  assignments: [
    {
      agentId: "a1",
      environmentId: vps,
      threadId: "old",
      task: "old",
      finishedAt: "x",
      createdAt: "1",
    },
    {
      agentId: "a1",
      environmentId: vps,
      threadId: "t1",
      task: "Ship",
      finishedAt: null,
      createdAt: "2",
    },
  ],
  sections: [
    { id: "s1", name: "Late", status: "in_progress", dueDate: "2026-10-12" },
    { id: "s2", name: "Far", status: "todo", dueDate: "2026-11-01" },
    { id: "s3", name: "Stuck", status: "blocked", dueDate: null },
    { id: "s4", name: "Done", status: "done", dueDate: "2026-10-14" },
  ],
  memory: [],
  income: [],
  costs: [],
} as unknown as CommandCenterSnapshot;

describe("summarizeCommandCenter", () => {
  it("groups agents by team machine and buckets what is missing", () => {
    // The question sits in a child thread the agent delegated to.
    const shell = (id: string, parentThreadId: string | null, pending: boolean) =>
      ({
        id,
        environmentId: vps,
        lineage: { parentThreadId },
        hasPendingApprovals: false,
        hasPendingUserInput: pending,
        runtime: null,
      }) as unknown as EnvironmentThreadShell;
    const shells = new Map([
      [threadShellKey(vps, "t1"), shell("t1", null, false)],
      [threadShellKey(vps, "child"), shell("child", "t1", true)],
    ]);
    const summary = summarizeCommandCenter(snapshot, shells, home, now);

    expect(
      summary.machines.map(({ environmentId, agents }) => [
        environmentId,
        agents.map(({ agent, status, task }) => [agent.name, status, task]),
      ]),
    ).toEqual([
      [vps, [["Asker", "waiting", "Ship"]]],
      [home, [["Loner", "idle", null]]],
    ]);
    expect(summary.waiting.map(({ agent, thread }) => [agent.name, thread?.threadId])).toEqual([
      ["Asker", "child"],
    ]);
    expect(summary.blocked.map((section) => section.name)).toEqual(["Stuck"]);
    expect(summary.dueSoon.map(({ section, days }) => [section.name, days])).toEqual([
      ["Late", -1],
    ]);
    expect(summary.upcoming.map(({ section }) => section.name)).toEqual(["Far"]);
  });
});

describe("sectionPullRequest", () => {
  const section = (prUrl: string | null | undefined, prNumber: number | null | undefined) =>
    ({ prUrl, prNumber }) as unknown as CommandCenterSection;

  it("labels a linked pull request by its number, read from the URL when not stored", () => {
    const url = "https://github.com/acme/app/pull/42";
    expect(sectionPullRequest(section(url, 7))).toEqual({ url, label: "PR #7" });
    expect(sectionPullRequest(section(url, null))).toEqual({ url, label: "PR #42" });
    expect(sectionPullRequest(section("https://example.com/review", null))?.label).toBe(
      "Pull request",
    );
  });

  it("is null for sections from older servers or with the link cleared", () => {
    expect(sectionPullRequest(section(undefined, undefined))).toBeNull();
    expect(sectionPullRequest(section(null, null))).toBeNull();
  });
});

describe("artifactDetail", () => {
  it("names the project, current version and age", () => {
    const artifact = {
      currentVersion: 3,
      updatedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    } as unknown as CommandCenterArtifact;
    expect(artifactDetail(artifact, "Web")).toBe("Web · v3 · 2h ago");
    expect(artifactDetail(artifact, null)).toBe("No project · v3 · 2h ago");
  });
});
