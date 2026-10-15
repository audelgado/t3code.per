import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { closeBlocker, dailyCounts, deriveWorkItems, workStage } from "./workItems";

const environmentId = EnvironmentId.make("pc");
const projectId = ProjectId.make("project");
const project: EnvironmentProject = {
  id: projectId,
  environmentId,
  title: "Project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
};
type Shell = Parameters<typeof deriveWorkItems>[0][number];
const shell = (id: string, patch: Partial<Shell> = {}): Shell => ({
  id: ThreadId.make(id),
  environmentId,
  projectId,
  branch: "feature",
  worktreePath: "/work",
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  archivedAt: null,
  deletedAt: null,
  updatedAt: "2026-10-14T00:00:00Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  interactionMode: "default",
  runtime: null,
  pullRequests: [],
  ...patch,
});
const item = deriveWorkItems([shell("thread")], [project])[0]!;
const status = (patch: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
  ...patch,
});
const pr = (state: "merged" | "open" | "closed") => ({
  number: 1,
  title: "Feature",
  url: "https://example.com/1",
  baseRef: "main",
  headRef: "feature",
  state,
});

describe("deriveWorkItems", () => {
  it("groups threads by environment, project and checkout, choosing the newest thread", () => {
    const other = { ...project, id: ProjectId.make("clone") };
    const remote = { ...project, environmentId: EnvironmentId.make("vps") };
    const result = deriveWorkItems(
      [
        shell("old", { updatedAt: "2026-10-13T00:00:00Z", hasPendingApprovals: true }),
        shell("new"),
        shell("root", { worktreePath: null }),
        shell("clone", { projectId: other.id }),
        shell("remote", { environmentId: remote.environmentId }),
      ],
      [project, other, remote],
    );
    expect(result).toHaveLength(4);
    const grouped = result.find((entry) => entry.threadIds.length === 2)!;
    expect(grouped.latestThreadId).toBe("new");
    expect(grouped.threadIds).toEqual(["new", "old"]);
    expect(grouped.agent).toBe("needs-you");
    expect(result.find((entry) => entry.latestThreadId === "root")?.cwd).toBe("/repo");
    expect(new Set(result.map((entry) => entry.key)).size).toBe(4);
  });

  it("skips archived, deleted, subagent, branchless and unknown-project threads", () => {
    expect(
      deriveWorkItems(
        [
          shell("archived", { archivedAt: "2026-10-14" }),
          shell("deleted", { deletedAt: "2026-10-14" }),
          shell("child", {
            lineage: {
              rootThreadId: ThreadId.make("parent"),
              parentThreadId: ThreadId.make("parent"),
              relationshipToParent: "subagent",
            },
          }),
          shell("no-branch", { branch: null }),
          shell("missing", { projectId: ProjectId.make("missing") }),
        ],
        [project],
      ),
    ).toEqual([]);
  });

  it("uses only PR snapshots on the work branch and ignores dismissed stack links", () => {
    const link: Shell["pullRequests"][number] = {
      host: "github.com",
      repository: "owner/repo",
      number: 1,
      url: "https://example.com/1",
      source: "manual",
      linkedAt: "2026-10-14T00:00:00Z",
      stack: null,
      snapshot: {
        state: "merged",
        title: "Feature",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-10-14T00:00:00Z",
      },
    };
    const derive = (links: Shell["pullRequests"]) =>
      deriveWorkItems([shell("pr", { pullRequests: links })], [project])[0]!.pr;
    expect(derive([link])?.state).toBe("merged");
    expect(derive([{ ...link, source: "stack-dismissed" }])).toBeNull();
    expect(derive([{ ...link, snapshot: { ...link.snapshot!, headBranch: "other" } }])).toBeNull();
  });
});

describe("work progress and close safety", () => {
  it("derives all six stages from observed status", () => {
    expect(workStage(item, status()).stage).toBe(0);
    expect(workStage(item, status({ hasWorkingTreeChanges: true })).stage).toBe(1);
    expect(workStage(item, status({ aheadCount: 2 })).stage).toBe(2);
    expect(workStage(item, status({ hasUpstream: true })).stage).toBe(3);
    expect(workStage(item, status({ pr: pr("open") })).stage).toBe(4);
    expect(workStage(item, status({ pr: pr("merged") })).stage).toBe(5);
    expect(workStage(item, null).stage).toBe(0);
  });

  it("allows merged or safely clean work, while guarding dirty and unpublished work", () => {
    expect(closeBlocker(item, status())).toBeNull();
    expect(closeBlocker(item, status({ hasUpstream: true }))).toBeNull();
    expect(closeBlocker(item, status({ pr: pr("merged") }))).toBeNull();
    expect(closeBlocker(item, status({ hasWorkingTreeChanges: true, pr: pr("merged") }))).toBe(
      "1 uncommitted",
    );
    expect(closeBlocker(item, status({ aheadCount: 5, pr: pr("merged") }))).toBe(
      "5 commits not pushed",
    );
    expect(closeBlocker(item, status({ aheadOfDefaultCount: 3 }))).toBe("3 commits not pushed");
    expect(closeBlocker(item, status({ pr: pr("open") }))).toBe("PR not merged");
  });

  it("never treats missing, nonrepo or wrong-branch status as safe", () => {
    expect(closeBlocker(item, null)).toBe("Load current branch status first");
    expect(closeBlocker(item, status({ isRepo: false }))).toBe("Load current branch status first");
    expect(closeBlocker(item, status({ refName: "other" }))).toBe(
      "Load current branch status first",
    );
    const { aheadOfDefaultCount: _, ...unknown } = status();
    expect(closeBlocker(item, unknown)).toBe("Upstream status unknown");
    expect(closeBlocker({ ...item, agent: "working" }, status())).toBe("Agent is working");
    expect(closeBlocker({ ...item, agent: "needs-you" }, status())).toBe("Needs your attention");
  });
});

describe("dailyCounts", () => {
  it("counts UTC days including today, dropping invalid, old and future timestamps", () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(
      dailyCounts(
        [
          "2026-10-12T00:00:00Z",
          "2026-10-13T23:59:00Z",
          "2026-10-14T00:00:00Z",
          "2026-10-14T11:00:00Z",
          "2026-10-14T13:00:00Z",
          "2026-10-11T23:59:00Z",
          "invalid",
        ],
        3,
        now,
      ),
    ).toEqual([1, 1, 2]);
    expect(dailyCounts([], 0, now)).toEqual([]);
    expect(dailyCounts([], Number.NaN, now)).toEqual([]);
    expect(dailyCounts([], 1000, now)).toHaveLength(366);
  });
});
