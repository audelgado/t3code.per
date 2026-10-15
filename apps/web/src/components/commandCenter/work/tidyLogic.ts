import type { VcsRef, VcsStatusResult } from "@t3tools/contracts";
import type { WorkItem } from "./workItems";
export const TIDY_GROUPS = ["uncommitted", "merged", "unpushed", "no-remote", "behind"] as const;
export type TidyGroup = (typeof TIDY_GROUPS)[number];
export const TIDY_LABELS: Record<TidyGroup, string> = {
  uncommitted: "Uncommitted",
  merged: "Merged PR, branch remains",
  unpushed: "Not pushed",
  "no-remote": "No remote",
  behind: "Behind upstream",
};
export interface TidyEntry {
  readonly key: string;
  readonly project: WorkItem["project"];
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly item: WorkItem | undefined;
  readonly status: VcsStatusResult | null;
  readonly group: TidyGroup;
}
/** Ref inventories cannot prove age or divergence from main; classify observed facts only. */
export function tidyGroup(status: VcsStatusResult | null, merged: boolean): TidyGroup | null {
  if (status?.hasWorkingTreeChanges) return "uncommitted";
  if (merged) return "merged";
  if (
    status &&
    (status.aheadCount > 0 || (!status.hasUpstream && (status.aheadOfDefaultCount ?? 0) > 0))
  )
    return "unpushed";
  if (status && !status.hasPrimaryRemote) return "no-remote";
  if (status && status.behindCount > 0) return "behind";
  return null;
}
export function canRemoveTidyWorktree(entry: TidyEntry) {
  return (
    entry.worktreePath !== null &&
    entry.worktreePath !== entry.project.workspaceRoot &&
    entry.status !== null &&
    entry.status.refName === entry.branch &&
    !entry.status.isDefaultRef &&
    !entry.status.hasWorkingTreeChanges &&
    entry.status.aheadCount === 0 &&
    (entry.status.hasUpstream || entry.status.aheadOfDefaultCount === 0) &&
    entry.item?.agent !== "working" &&
    entry.item?.agent !== "needs-you" &&
    entry.group === "merged"
  );
}
export function inventoryEntries(
  project: WorkItem["project"],
  refs: readonly VcsRef[],
  items: readonly WorkItem[],
  statusOf: (item: WorkItem) => VcsStatusResult | null,
  mergedHeads: ReadonlySet<string>,
): TidyEntry[] {
  return refs
    .filter((ref) => !ref.isRemote)
    .flatMap((ref) => {
      const item = items.find(
        (item) => item.branch === ref.name && (!ref.worktreePath || item.cwd === ref.worktreePath),
      );
      const observed = item ? statusOf(item) : null;
      const status = observed?.refName === ref.name ? observed : null;
      const merged =
        mergedHeads.has(ref.name) || status?.pr?.state === "merged" || item?.pr?.state === "merged";
      const group = tidyGroup(status, merged);
      return group
        ? [
            {
              key: JSON.stringify([project.environmentId, project.id, ref.name]),
              project,
              branch: ref.name,
              worktreePath: ref.worktreePath,
              item,
              status,
              group,
            },
          ]
        : [];
    });
}
/** A read-only inspection command, quoted for a POSIX shell. */
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export const tidyCommand = (entry: TidyEntry) =>
  `git -C ${shellQuote(entry.worktreePath ?? entry.project.workspaceRoot)} status --short --branch`;
