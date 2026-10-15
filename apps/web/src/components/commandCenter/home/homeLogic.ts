import {
  deriveWorkingThreads,
  type CommandCenterAttention,
} from "@t3tools/client-runtime/state/commandCenterDerive";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ServerSettings } from "@t3tools/contracts";
import { compareManual } from "../projectOrder";
import { projectEntryKey } from "../projects/projectDirectory";
import { dailyCounts, workStage, type WorkItem } from "../work/workItems";

/** Pins remain scoped to their own project and environment. */
export function pinnedProjects(
  entries: ServerSettings["commandCenter"]["projects"],
  projects: readonly EnvironmentProject[],
  order: readonly string[],
) {
  const pinned = new Set(entries.filter((entry) => entry.pinned).map((entry) => entry.key));
  const compare = compareManual(order);
  return projects
    .filter((project) => pinned.has(projectEntryKey(project)))
    .toSorted((a, b) => compare(projectEntryKey(a), projectEntryKey(b)))
    .slice(0, 8);
}

export function nowCounts(
  shells: readonly EnvironmentThreadShell[],
  attention: readonly (
    | Pick<Extract<CommandCenterAttention, { kind: "thread" }>, "kind" | "reason">
    | { readonly kind: Exclude<CommandCenterAttention["kind"], "thread"> }
  )[],
  items: readonly WorkItem[],
) {
  const needsYouByReason = { approval: 0, input: 0, plan: 0, other: 0 };
  for (const item of attention) {
    if (item.kind === "thread") needsYouByReason[item.reason]++;
    else needsYouByReason.other++;
  }
  const activeWorkByStage = [0, 0, 0, 0, 0, 0];
  for (const item of items) activeWorkByStage[workStage(item, null).stage]!++;
  return { working: deriveWorkingThreads(shells).length, needsYouByReason, activeWorkByStage };
}

/** Shells carry the latest run only, so charts count the observed completions. */
export function completedBuckets(
  shells: readonly Pick<EnvironmentThreadShell, "latestRun" | "deletedAt" | "lineage">[],
  now: number,
) {
  return dailyCounts(
    shells.flatMap((shell) =>
      shell.deletedAt === null &&
      shell.lineage.relationshipToParent !== "subagent" &&
      shell.latestRun?.completedAt
        ? [shell.latestRun.completedAt]
        : [],
    ),
    7,
    now,
  );
}
