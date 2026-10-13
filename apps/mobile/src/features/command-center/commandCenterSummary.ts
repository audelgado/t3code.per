import {
  type CommandCenterAgentStatus,
  daysUntil,
  deriveAgentState,
  latestAssignmentByAgent,
  pendingChildrenByParent,
  threadShellKey,
} from "@t3tools/client-runtime/state/commandCenterDerive";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  pullRequestNumberFromUrl,
  type CommandCenterAgentProfile,
  type CommandCenterArtifact,
  type CommandCenterSection,
  type CommandCenterSnapshot,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { relativeTime } from "../../lib/time";

export interface SummaryAgent {
  readonly agent: CommandCenterAgentProfile;
  readonly status: CommandCenterAgentStatus;
  /** Task of the current (unfinished) assignment. */
  readonly task: string | null;
  /** Thread to open: the one holding the question while waiting, else the current task's. */
  readonly thread: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}

export interface SummaryDelivery {
  readonly section: CommandCenterSection;
  /** Whole days until the due date; negative when overdue. */
  readonly days: number;
}

export interface CommandCenterSummary {
  /** Agents grouped by the machine their team runs on, in first-seen order. */
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly agents: ReadonlyArray<SummaryAgent>;
  }>;
  readonly waiting: ReadonlyArray<SummaryAgent>;
  readonly blocked: ReadonlyArray<CommandCenterSection>;
  /** Open sections due within 7 days, overdue included. */
  readonly dueSoon: ReadonlyArray<SummaryDelivery>;
  /** The next open sections due after that week. */
  readonly upcoming: ReadonlyArray<SummaryDelivery>;
}

const UPCOMING_LIMIT = 10;

/**
 * Read-only digest of one environment's Command Center snapshot. `storeEnvironmentId` is the
 * environment the snapshot came from; teams with no machine run there.
 */
export function summarizeCommandCenter(
  snapshot: CommandCenterSnapshot,
  shells: ReadonlyMap<string, EnvironmentThreadShell>,
  storeEnvironmentId: EnvironmentId,
  now: number,
): CommandCenterSummary {
  const latest = latestAssignmentByAgent(snapshot.assignments);
  const pendingChildren = pendingChildrenByParent([...shells.values()]);
  const teamMachine = new Map(
    snapshot.teams
      .filter((team) => team.archivedAt === null)
      .map((team) => [team.id, team.environmentId ?? storeEnvironmentId] as const),
  );

  const machines = new Map<EnvironmentId, SummaryAgent[]>();
  const waiting: SummaryAgent[] = [];
  const agents = snapshot.agentProfiles
    .filter((agent) => agent.archivedAt === null)
    .sort((left, right) => left.sortKey - right.sortKey);
  for (const agent of agents) {
    const assignment = latest.get(agent.id) ?? null;
    const key = assignment ? threadShellKey(assignment.environmentId, assignment.threadId) : "";
    const shell = assignment ? (shells.get(key) ?? null) : null;
    const { status, waitingThreadId } = deriveAgentState(
      assignment,
      shell,
      now,
      pendingChildren.get(key) ?? null,
    );
    const open = assignment !== null && assignment.finishedAt === null;
    const entry: SummaryAgent = {
      agent,
      status,
      task: open ? assignment.task : null,
      thread: open
        ? {
            environmentId: assignment.environmentId,
            threadId: waitingThreadId ?? assignment.threadId,
          }
        : null,
    };
    const machine =
      (agent.teamId ? teamMachine.get(agent.teamId) : undefined) ?? storeEnvironmentId;
    machines.set(machine, [...(machines.get(machine) ?? []), entry]);
    if (status === "waiting") waiting.push(entry);
  }

  const dated = snapshot.sections
    .filter((section) => section.status !== "done" && section.dueDate !== null)
    .map((section) => ({ section, days: daysUntil(section.dueDate!, now) }))
    .sort((left, right) => left.days - right.days);

  return {
    machines: [...machines].map(([environmentId, list]) => ({ environmentId, agents: list })),
    waiting,
    blocked: snapshot.sections.filter((section) => section.status === "blocked"),
    dueSoon: dated.filter(({ days }) => days <= 7),
    upcoming: dated.filter(({ days }) => days > 7).slice(0, UPCOMING_LIMIT),
  };
}

export function formatDue(days: number) {
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "due today";
  return `due in ${days} day${days === 1 ? "" : "s"}`;
}

/** A section's linked pull request as a tappable label, or null when none is linked. */
export function sectionPullRequest(section: CommandCenterSection) {
  const url = section.prUrl ?? null;
  if (url === null) return null;
  const number = section.prNumber ?? pullRequestNumberFromUrl(url);
  return { url, label: number === null ? "Pull request" : `PR #${number}` };
}

/** "Project · v3 · 2h ago" under an artifact's title; a null project means a global artifact. */
export function artifactDetail(artifact: CommandCenterArtifact, projectTitle: string | null) {
  return [
    projectTitle ?? "No project",
    `v${artifact.currentVersion}`,
    `${relativeTime(artifact.updatedAt)} ago`,
  ].join(" · ");
}
