import { describe, expect, it } from "vite-plus/test";
import type { VcsStatusResult } from "@t3tools/contracts";
import { canRemoveTidyWorktree, inventoryEntries, tidyGroup, type TidyEntry } from "./tidyLogic";
import { testItem } from "./workTestFixtures";
const item = testItem();
const status = (patch: Partial<VcsStatusResult> = {}): VcsStatusResult => ({
  isRepo: true,
  isDefaultRef: false,
  hasPrimaryRemote: true,
  refName: item.branch,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
  pr: null,
  ...patch,
});
const entry = (patch: Partial<TidyEntry> = {}): TidyEntry => ({
  key: "entry",
  project: item.project,
  branch: item.branch,
  worktreePath: item.worktreePath,
  item,
  status: status(),
  group: "merged",
  ...patch,
});
describe("Tidy observed facts", () => {
  it("prioritizes uncommitted over merged and unpushed over behind", () => {
    expect(tidyGroup(status({ hasWorkingTreeChanges: true }), true)).toBe("uncommitted");
    expect(tidyGroup(status({ aheadCount: 1, behindCount: 2 }), false)).toBe("unpushed");
    expect(tidyGroup(status({ hasPrimaryRemote: false }), false)).toBe("no-remote");
    expect(tidyGroup(status({ behindCount: 2 }), false)).toBe("behind");
    expect(tidyGroup(null, false)).toBeNull();
  });
  it("recognizes squash merges by project-scoped PR heads without inventing health", () => {
    const refs = [
      { name: item.branch, current: false, isDefault: false, worktreePath: item.worktreePath },
    ];
    expect(
      inventoryEntries(item.project, refs, [item], () => null, new Set([item.branch]))[0]?.group,
    ).toBe("merged");
    expect(inventoryEntries(item.project, refs, [item], () => null, new Set())).toEqual([]);
  });
  it("never removes dirty, default, unpublished, working, root or unknown worktrees", () => {
    expect(canRemoveTidyWorktree(entry())).toBe(true);
    for (const patch of [
      { hasWorkingTreeChanges: true },
      { isDefaultRef: true },
      { aheadCount: 2 },
      { hasUpstream: false, aheadOfDefaultCount: 2 },
    ])
      expect(canRemoveTidyWorktree(entry({ status: status(patch) }))).toBe(false);
    expect(canRemoveTidyWorktree(entry({ status: null }))).toBe(false);
    expect(canRemoveTidyWorktree(entry({ worktreePath: item.project.workspaceRoot }))).toBe(false);
    expect(canRemoveTidyWorktree(entry({ item: { ...item, agent: "working" } }))).toBe(false);
    expect(canRemoveTidyWorktree(entry({ group: "uncommitted" }))).toBe(false);
  });
  it("does not borrow status from a different branch", () => {
    expect(
      inventoryEntries(
        item.project,
        [{ name: item.branch, current: false, isDefault: false, worktreePath: item.worktreePath }],
        [item],
        () => status({ refName: "other", hasWorkingTreeChanges: true }),
        new Set(),
      ),
    ).toEqual([]);
  });
});
