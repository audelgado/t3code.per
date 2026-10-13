// @effect-diagnostics globalDate:off -- Delivery countdowns use the viewer's local calendar days.
import type {
  CommandCenterAgentId,
  CommandCenterAssignment,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

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
