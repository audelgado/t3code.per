// @effect-diagnostics globalDate:off -- Delivery countdowns use the viewer's local calendar days.
import type {
  CommandCenterAgentId,
  CommandCenterAssignment,
  CommandCenterIncome,
  CommandCenterMemoryEntry,
  CommandCenterSection,
  CommandCenterSnapshot,
  CommandCenterWorkflowRun,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import {
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

// Derived Command Center state shared by web and mobile. Runs on Hermes: no `toSorted`.

/** What an agent is doing right now, derived from the thread of its latest assignment. */
export type CommandCenterAgentStatus = "working" | "waiting" | "blocked" | "limited" | "idle";

export interface CommandCenterAgentState {
  readonly status: CommandCenterAgentStatus;
  /** Latest assignment, finished or not; null when the agent never had one. */
  readonly assignment: CommandCenterAssignment | null;
  /** Thread shell of that assignment, when its environment is connected and streaming. */
  readonly shell: EnvironmentThreadShell | null;
  /** ISO time the current activity started, for an elapsed label. Null when idle. */
  readonly since: string | null;
  /**
   * Thread holding the question or approval while `waiting`: the assignment's own thread, or a
   * child it delegated to. Null otherwise.
   */
  readonly waitingThreadId: ThreadId | null;
}

export const threadShellKey = (environmentId: EnvironmentId, threadId: string) =>
  `${environmentId}:${threadId}`;

/** Latest assignment per agent, by `createdAt`. */
export function latestAssignmentByAgent(
  assignments: ReadonlyArray<CommandCenterAssignment>,
): ReadonlyMap<CommandCenterAgentId, CommandCenterAssignment> {
  const latest = new Map<CommandCenterAgentId, CommandCenterAssignment>();
  for (const assignment of assignments) {
    const current = latest.get(assignment.agentId);
    if (!current || current.createdAt < assignment.createdAt) {
      latest.set(assignment.agentId, assignment);
    }
  }
  return latest;
}

/**
 * Child threads waiting on the user, by their parent's `threadShellKey`, so an agent that
 * delegated (the onboarding Lead runs Scout and Organizer as children) surfaces their questions.
 */
export function pendingChildrenByParent(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyMap<string, EnvironmentThreadShell> {
  const pending = new Map<string, EnvironmentThreadShell>();
  for (const shell of shells) {
    const parent = shell.lineage.parentThreadId;
    if (parent === null || !(shell.hasPendingApprovals || shell.hasPendingUserInput)) continue;
    pending.set(threadShellKey(shell.environmentId, parent), shell);
  }
  return pending;
}

const ACTIVE_RUNTIME = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * Status precedence: a question for the user (in the thread or a child it delegated to) beats
 * everything, then a usage limit, then a failure, then an active run. A finished assignment or
 * a thread we cannot see reads as idle.
 */
export function deriveAgentState(
  assignment: CommandCenterAssignment | null,
  shell: EnvironmentThreadShell | null,
  now: number,
  pendingChild: EnvironmentThreadShell | null = null,
): CommandCenterAgentState {
  if (!assignment || assignment.finishedAt !== null || !shell) {
    return { status: "idle", assignment, shell, since: null, waitingThreadId: null };
  }
  const runtime = shell.runtime;
  const ownQuestion = shell.hasPendingApprovals || shell.hasPendingUserInput;
  const status: CommandCenterAgentStatus =
    ownQuestion || pendingChild !== null
      ? "waiting"
      : runtime?.usageLimitResetAt && Date.parse(runtime.usageLimitResetAt) > now
        ? "limited"
        : runtime?.status === "failed"
          ? "blocked"
          : runtime && ACTIVE_RUNTIME.has(runtime.status)
            ? "working"
            : "idle";
  const since = runtime?.activityStartedAt ?? assignment.createdAt;
  return {
    status,
    assignment,
    shell,
    since: status === "idle" ? null : since,
    waitingThreadId: ownQuestion ? shell.id : (pendingChild?.id ?? null),
  };
}

const DAY_MS = 86_400_000;

/** Whole days from today (local) to a `YYYY-MM-DD` date; negative when overdue. */
export function daysUntil(date: string, now: number) {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((new Date(year, month - 1, day).getTime() - startOfToday) / DAY_MS);
}

/** Open sections due in the next 7 days (today included) and those already past due. */
export function countSectionDeadlines(
  sections: ReadonlyArray<Pick<CommandCenterSection, "status" | "dueDate">>,
  now: number,
) {
  let dueSoon = 0;
  let overdue = 0;
  for (const section of sections) {
    if (section.status === "done" || section.dueDate === null) continue;
    const days = daysUntil(section.dueDate, now);
    if (days < 0) overdue += 1;
    else if (days <= 7) dueSoon += 1;
  }
  return { dueSoon, overdue };
}

/** Status of every agent profile, joined from its latest assignment and that thread's shell. */
export function deriveAgentStates(
  snapshot: Pick<CommandCenterSnapshot, "agentProfiles" | "assignments">,
  shells: ReadonlyArray<EnvironmentThreadShell>,
  now: number,
): ReadonlyMap<CommandCenterAgentId, CommandCenterAgentState> {
  const shellByKey = new Map<string, EnvironmentThreadShell>();
  for (const shell of shells) shellByKey.set(threadShellKey(shell.environmentId, shell.id), shell);
  const latest = latestAssignmentByAgent(snapshot.assignments);
  const pendingChildren = pendingChildrenByParent(shells);
  const states = new Map<CommandCenterAgentId, CommandCenterAgentState>();
  for (const agent of snapshot.agentProfiles) {
    const assignment = latest.get(agent.id) ?? null;
    const key = assignment ? threadShellKey(assignment.environmentId, assignment.threadId) : "";
    const shell = assignment ? (shellByKey.get(key) ?? null) : null;
    states.set(
      agent.id,
      deriveAgentState(assignment, shell, now, pendingChildren.get(key) ?? null),
    );
  }
  return states;
}

/** Prefix the onboarding Lead gives interview questions it saves as todos (see onboarding.ts). */
export const COMMAND_CENTER_QUESTION_PREFIX = "Question: ";
/** Sections under this percent done read as at risk near their due date. */
export const AT_RISK_PERCENT = 70;

export function sectionPercent(section: Pick<CommandCenterSection, "tasksDone" | "tasksTotal">) {
  return section.tasksTotal === 0
    ? 0
    : Math.round((Math.min(section.tasksDone, section.tasksTotal) / section.tasksTotal) * 100);
}

/**
 * Minutes a working agent may go without any new thread activity before it reads as stuck.
 * Activity is the newer of the thread shell's and its runtime's `updatedAt`.
 */
export const STUCK_AFTER_MINUTES = 30;
/** Deliveries this close (in days) under `AT_RISK_PERCENT` done raise an alert. */
export const DELIVERY_ALERT_DAYS = 2;

export type CommandCenterAlert =
  | { readonly kind: "offline"; readonly environmentId: string; readonly label: string }
  | {
      readonly kind: "stuck";
      readonly agentId: CommandCenterAgentId;
      readonly minutes: number;
      readonly assignment: CommandCenterAssignment | null;
    }
  | {
      readonly kind: "delivery";
      readonly section: CommandCenterSection;
      readonly days: number;
      readonly percent: number;
    };

interface AttentionEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connected: boolean;
}

/**
 * Client-side alerts, computed from data the page already has (no polling, no server work):
 * a machine that hosts teams or open work is disconnected, a working agent has shown no
 * activity for `STUCK_AFTER_MINUTES`, or a delivery is due within 48 hours under 70% done.
 */
export function commandCenterAlerts({
  environments,
  hostEnvironmentIds,
  agents,
  sections,
  now,
}: {
  readonly environments: ReadonlyArray<AttentionEnvironment>;
  /** Machines that host a team or an unfinished assignment. */
  readonly hostEnvironmentIds: ReadonlySet<string>;
  readonly agents: ReadonlyArray<{
    readonly agentId: CommandCenterAgentId;
    readonly state: CommandCenterAgentState;
  }>;
  readonly sections: ReadonlyArray<CommandCenterSection>;
  readonly now: number;
}): CommandCenterAlert[] {
  const alerts: CommandCenterAlert[] = [];
  for (const environment of environments) {
    if (!environment.connected && hostEnvironmentIds.has(environment.environmentId)) {
      alerts.push({
        kind: "offline",
        environmentId: environment.environmentId,
        label: environment.label,
      });
    }
  }
  for (const { agentId, state } of agents) {
    if (state.status !== "working" || state.shell === null) continue;
    const last = Math.max(
      Date.parse(state.shell.updatedAt),
      state.shell.runtime ? Date.parse(state.shell.runtime.updatedAt) : 0,
    );
    const minutes = Math.floor((now - last) / 60_000);
    if (minutes >= STUCK_AFTER_MINUTES) {
      alerts.push({ kind: "stuck", agentId, minutes, assignment: state.assignment });
    }
  }
  for (const section of sections) {
    if (section.status === "done" || section.status === "review" || section.dueDate === null) {
      continue;
    }
    const days = daysUntil(section.dueDate, now);
    const percent = sectionPercent(section);
    if (days >= 0 && days <= DELIVERY_ALERT_DAYS && percent < AT_RISK_PERCENT) {
      alerts.push({ kind: "delivery", section, days, percent });
    }
  }
  return alerts;
}

export type CommandCenterAttentionReason = "approval" | "input" | "plan";

/** One row of Home's "Needs you" list. `key` stays the same while the item does. */
export type CommandCenterAttention =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly shell: EnvironmentThreadShell;
      readonly reason: CommandCenterAttentionReason;
    }
  | { readonly kind: "run"; readonly key: string; readonly run: CommandCenterWorkflowRun }
  | (CommandCenterAlert & { readonly key: string })
  | { readonly kind: "question"; readonly key: string; readonly entry: CommandCenterMemoryEntry }
  | { readonly kind: "blocked"; readonly key: string; readonly section: CommandCenterSection }
  | { readonly kind: "overdue"; readonly key: string; readonly income: CommandCenterIncome };

function attentionReason(shell: EnvironmentThreadShell): CommandCenterAttentionReason | null {
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "input";
  // The sidebar's "Plan Ready": a plan-mode thread with an actionable plan and a settled run.
  return shell.interactionMode === "plan" &&
    shell.hasActionableProposedPlan &&
    !isThreadWorking(shell)
    ? "plan"
    : null;
}

const alertKey = (alert: CommandCenterAlert) =>
  alert.kind === "offline"
    ? `offline:${alert.environmentId}`
    : alert.kind === "stuck"
      ? `stuck:${alert.agentId}`
      : `risk:${alert.section.id}`;

/**
 * Everything waiting on the user, from data the page already streams. First threads on any
 * machine with an approval, a question or a ready plan (not archived, and not snoozed unless
 * they raised their hand), in the inbox's return order, then workflow runs waiting on an answer
 * or a check, newest change first. Then Command Center alerts (offline hosts, stuck agents,
 * deliveries at risk), then interview questions, blocked sections and overdue income, newest
 * first. Idle agents are not attention.
 */
export function deriveAttention({
  shells,
  snapshot,
  environments,
  primaryEnvironmentId,
  now,
  runs = [],
}: {
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly snapshot: CommandCenterSnapshot;
  readonly environments: ReadonlyArray<AttentionEnvironment>;
  /** Machine of a team saved without one. */
  readonly primaryEnvironmentId: string;
  readonly now: number;
  /** Workflow runs from a run feed; only waiting ones are attention. */
  readonly runs?: ReadonlyArray<CommandCenterWorkflowRun> | undefined;
}): CommandCenterAttention[] {
  const nowIso = new Date(now).toISOString();
  const reasons = new Map<EnvironmentThreadShell, CommandCenterAttentionReason>();
  for (const shell of shells) {
    if (shell.archivedAt !== null || shell.deletedAt !== null) continue;
    const reason = attentionReason(shell);
    if (reason !== null && !effectiveSnoozed(shell, { now: nowIso })) reasons.set(shell, reason);
  }
  const threads = sortInboxThreadsByReturn([...reasons.keys()]).map(
    (shell): CommandCenterAttention => ({
      kind: "thread",
      key: `thread:${threadShellKey(shell.environmentId, shell.id)}`,
      shell,
      reason: reasons.get(shell)!,
    }),
  );
  const waitingRuns = runs
    .filter((run) => run.status === "waiting")
    .sort((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
    )
    .map((run): CommandCenterAttention => ({ kind: "run", key: `run:${run.id}`, run }));

  const states = deriveAgentStates(snapshot, shells, now);
  const hostEnvironmentIds = new Set<string>();
  for (const team of snapshot.teams) {
    if (team.archivedAt === null) {
      hostEnvironmentIds.add(team.environmentId ?? primaryEnvironmentId);
    }
  }
  for (const assignment of snapshot.assignments) {
    if (assignment.finishedAt === null) hostEnvironmentIds.add(assignment.environmentId);
  }
  const alerts = commandCenterAlerts({
    environments,
    hostEnvironmentIds,
    agents: snapshot.agentProfiles.flatMap((agent) => {
      const state = states.get(agent.id);
      return agent.archivedAt === null && state ? [{ agentId: agent.id, state }] : [];
    }),
    sections: snapshot.sections,
    now,
  }).map((alert): CommandCenterAttention => ({ ...alert, key: alertKey(alert) }));

  const dated: { readonly at: string; readonly item: CommandCenterAttention }[] = [];
  for (const entry of snapshot.memory) {
    if (
      entry.kind === "todo" &&
      !entry.done &&
      entry.text.startsWith(COMMAND_CENTER_QUESTION_PREFIX)
    ) {
      dated.push({
        at: entry.createdAt,
        item: { kind: "question", key: `question:${entry.id}`, entry },
      });
    }
  }
  for (const section of snapshot.sections) {
    if (section.status === "blocked") {
      dated.push({
        at: section.updatedAt,
        item: { kind: "blocked", key: `blocked:${section.id}`, section },
      });
    }
  }
  for (const income of snapshot.income) {
    if (income.status === "overdue") {
      dated.push({
        at: income.date,
        item: { kind: "overdue", key: `overdue:${income.id}`, income },
      });
    }
  }
  dated.sort((left, right) => (left.at < right.at ? 1 : left.at > right.at ? -1 : 0));
  return [...threads, ...waitingRuns, ...alerts, ...dated.map(({ item }) => item)];
}

/** Top-level threads with a run in progress that does not need the user, newest send first. */
export function deriveWorkingThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell[] {
  return sortWorkingThreadsBySend(
    shells.filter(
      (shell) =>
        shell.archivedAt === null &&
        shell.deletedAt === null &&
        shell.lineage.relationshipToParent !== "subagent" &&
        threadRuntimeIsActive(shell.runtime) &&
        isThreadWorking(shell),
    ),
  );
}
