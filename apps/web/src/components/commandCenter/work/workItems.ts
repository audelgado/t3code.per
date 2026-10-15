// @effect-diagnostics globalDate:off -- Sparkline buckets use explicit UTC dates supplied by the viewer.
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ThreadId, VcsStatusResult, ThreadPullRequestSnapshot } from "@t3tools/contracts";

import { projectEntryKey } from "../projects/projectDirectory";

export interface WorkPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: ThreadPullRequestSnapshot["state"] | null;
  readonly isDraft: boolean;
  readonly checksState: ThreadPullRequestSnapshot["checksState"];
}

export interface WorkItem {
  readonly key: string;
  readonly projectKey: string;
  readonly project: EnvironmentProject;
  readonly environmentId: EnvironmentProject["environmentId"];
  readonly projectId: EnvironmentProject["id"];
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly cwd: string;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly latestThreadId: ThreadId;
  readonly agent: "working" | "needs-you" | "idle";
  readonly pr: WorkPullRequest | null;
  readonly updatedAt: string;
}

type WorkShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "branch"
  | "worktreePath"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "runtime"
  | "pullRequests"
  | "branchPullRequest"
  | "linkedPullRequest"
>;

function shellPr(shell: WorkShell): WorkPullRequest | null {
  const legacy = shell.branchPullRequest ?? shell.linkedPullRequest;
  const links = shell.pullRequests.filter(
    (link) => link.source !== "stack-dismissed" && link.snapshot?.headBranch === shell.branch,
  );
  const link =
    links.find((entry) => entry.number === legacy?.number && entry.url === legacy.url) ??
    links
      .slice()
      .sort((a, b) =>
        (b.snapshot?.syncedAt ?? b.linkedAt).localeCompare(a.snapshot?.syncedAt ?? a.linkedAt),
      )[0];
  if (link)
    return {
      number: link.number,
      url: link.url,
      state: link.snapshot?.state ?? null,
      isDraft: link.snapshot?.isDraft ?? false,
      checksState: link.snapshot?.checksState,
    };
  return legacy
    ? {
        number: legacy.number,
        url: legacy.url,
        state: null,
        isDraft: false,
        checksState: undefined,
      }
    : null;
}

/** Each project and environment owns its work, even when repository remotes match. */
export function deriveWorkItems(
  shells: ReadonlyArray<WorkShell>,
  projects: ReadonlyArray<EnvironmentProject>,
): WorkItem[] {
  const byProject = new Map(projects.map((project) => [projectEntryKey(project), project]));
  const groups = new Map<string, WorkItem>();
  const sorted = shells.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const shell of sorted) {
    if (
      shell.archivedAt !== null ||
      shell.deletedAt !== null ||
      shell.lineage.relationshipToParent === "subagent" ||
      !shell.branch
    )
      continue;
    const projectKey = projectEntryKey({ environmentId: shell.environmentId, id: shell.projectId });
    const project = byProject.get(projectKey);
    if (!project) continue;
    const key = JSON.stringify([
      shell.environmentId,
      shell.projectId,
      shell.worktreePath ?? shell.branch,
    ]);
    const needsYou =
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput ||
      (shell.interactionMode === "plan" &&
        shell.hasActionableProposedPlan &&
        !threadRuntimeIsActive(shell.runtime));
    const agent = needsYou
      ? "needs-you"
      : threadRuntimeIsActive(shell.runtime)
        ? "working"
        : "idle";
    const current = groups.get(key);
    if (current) {
      groups.set(key, {
        ...current,
        threadIds: [...current.threadIds, shell.id],
        agent:
          current.agent === "needs-you" || agent === "needs-you"
            ? "needs-you"
            : current.agent === "working" || agent === "working"
              ? "working"
              : "idle",
        pr: current.pr ?? shellPr(shell),
      });
    } else
      groups.set(key, {
        key,
        projectKey,
        project,
        environmentId: shell.environmentId,
        projectId: shell.projectId,
        branch: shell.branch,
        worktreePath: shell.worktreePath,
        cwd: shell.worktreePath ?? project.workspaceRoot,
        threadIds: [shell.id],
        latestThreadId: shell.id,
        agent,
        pr: shellPr(shell),
        updatedAt: shell.updatedAt,
      });
  }
  return [...groups.values()];
}

export const WORK_STAGES = ["Created", "Working", "Committed", "Pushed", "PR", "Merged"] as const;
export type WorkStage = { readonly stage: 0 | 1 | 2 | 3 | 4 | 5; readonly blocked?: string };

const matchesStatus = (item: WorkItem, status: VcsStatusResult | null): status is VcsStatusResult =>
  status !== null && status.isRepo && status.refName === item.branch;

/** A clean checkout alone does not prove that local commits are safely published. */
export function closeBlocker(item: WorkItem, status: VcsStatusResult | null): string | null {
  if (item.agent !== "idle")
    return item.agent === "working" ? "Agent is working" : "Needs your attention";
  if (!matchesStatus(item, status)) return "Load current branch status first";
  if (status.hasWorkingTreeChanges)
    return `${Math.max(1, status.workingTree.files.length)} uncommitted`;
  if (status.aheadCount > 0) return `${status.aheadCount} commits not pushed`;
  const pr = status.pr ?? item.pr;
  if (pr?.state === "merged") return null;
  if (pr !== null && pr.state !== "closed") return "PR not merged";
  if (!status.hasUpstream) {
    if (status.aheadOfDefaultCount === undefined) return "Upstream status unknown";
    if (status.aheadOfDefaultCount > 0) return `${status.aheadOfDefaultCount} commits not pushed`;
  }
  return null;
}

/** Progress uses only observed branch data; unknown status never implies a push. */
export function workStage(item: WorkItem, status: VcsStatusResult | null): WorkStage {
  const current = matchesStatus(item, status) ? status : null;
  const pr = current?.pr ?? item.pr;
  const stage =
    pr?.state === "merged"
      ? 5
      : pr !== null && pr.state !== "closed"
        ? 4
        : item.agent !== "idle" || current?.hasWorkingTreeChanges
          ? 1
          : current &&
              (current.aheadCount > 0 ||
                (!current.hasUpstream && (current.aheadOfDefaultCount ?? 0) > 0))
            ? 2
            : current?.hasUpstream
              ? 3
              : 0;
  const blocked = closeBlocker(item, current);
  return blocked === null ? { stage } : { stage, blocked };
}

/** Oldest-to-newest UTC calendar buckets, including today and excluding future events. */
export function dailyCounts(
  timestamps: ReadonlyArray<string>,
  days: number,
  now: number,
): number[] {
  const count = Math.min(366, Math.max(0, Math.floor(days)));
  if (!Number.isFinite(count) || !Number.isFinite(now)) return [];
  const today = Math.floor(now / 86_400_000);
  const counts = Array.from({ length: count }, () => 0);
  for (const timestamp of timestamps) {
    const time = Date.parse(timestamp);
    const index = Math.floor(time / 86_400_000) - today + count - 1;
    if (time <= now && index >= 0 && index < count) counts[index]! += 1;
  }
  return counts;
}
