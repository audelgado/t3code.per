import type {
  CommandCenterAgentId,
  CommandCenterAgentProfile,
  CommandCenterAssignment,
  CommandCenterMemoryEntry,
  CommandCenterSection,
  CommandCenterTeam,
  CommandCenterTeamId,
} from "@t3tools/contracts";

import { daysUntil } from "@t3tools/client-runtime/state/commandCenterDerive";

import type { CommandCenterAgentState } from "../logic";
import { AT_RISK_PERCENT, sectionPercent } from "../projects/logic";

export interface CommandCenterHandoff {
  readonly entry: CommandCenterMemoryEntry;
  /** Team of the agent whose thread wrote the entry. */
  readonly from: CommandCenterTeamId | null;
  /** First other team named in the text. */
  readonly to: CommandCenterTeamId | null;
}

/**
 * Handoff memory entries resolved to teams, newest first. Memory rows carry no team, so the
 * sender comes from the thread's assignment and the receiver from a team name in the text.
 */
export function resolveHandoffs(
  memory: ReadonlyArray<CommandCenterMemoryEntry>,
  assignments: ReadonlyArray<CommandCenterAssignment>,
  agents: ReadonlyArray<CommandCenterAgentProfile>,
  teams: ReadonlyArray<CommandCenterTeam>,
  limit: number,
): CommandCenterHandoff[] {
  const agentTeam = new Map(agents.map((agent) => [agent.id, agent.teamId] as const));
  const threadTeam = new Map(
    assignments.map(
      (assignment) => [assignment.threadId, agentTeam.get(assignment.agentId) ?? null] as const,
    ),
  );
  const liveTeams = teams.filter((team) => team.archivedAt === null);
  return memory
    .filter((entry) => entry.kind === "handoff")
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map((entry) => {
      const from = entry.threadId ? (threadTeam.get(entry.threadId) ?? null) : null;
      const text = entry.text.toLowerCase();
      const to =
        liveTeams.find((team) => team.id !== from && text.includes(team.name.toLowerCase()))?.id ??
        null;
      return { entry, from, to };
    });
}

export { daysUntil };

/**
 * Minutes a working agent may go without any new thread activity before it reads as stuck.
 * Activity is the newer of the thread shell's and its runtime's `updatedAt`.
 */
export const STUCK_AFTER_MINUTES = 30;
/** Deliveries this close (in days) under `AT_RISK_PERCENT` done raise an alert. */
export const DELIVERY_ALERT_DAYS = 2;

export type CommandCenterAlert =
  | { readonly kind: "offline"; readonly environmentId: string; readonly label: string }
  | { readonly kind: "stuck"; readonly agentId: CommandCenterAgentId; readonly minutes: number }
  | {
      readonly kind: "delivery";
      readonly section: CommandCenterSection;
      readonly days: number;
      readonly percent: number;
    };

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
  readonly environments: ReadonlyArray<{
    readonly environmentId: string;
    readonly label: string;
    readonly connected: boolean;
  }>;
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
    if (minutes >= STUCK_AFTER_MINUTES) alerts.push({ kind: "stuck", agentId, minutes });
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

export interface CommandCenterDependencyWire {
  readonly section: CommandCenterSection;
  readonly dependency: CommandCenterSection;
  /** Team working on the waiting section, from its newest assignment. */
  readonly from: CommandCenterTeamId | null;
  /** Team working on the section it waits on. */
  readonly to: CommandCenterTeamId | null;
}

/** One wire per unmet dependency, with the teams resolved through section assignments. */
export function resolveDependencyWires(
  unmet: ReadonlyMap<CommandCenterSection["id"], ReadonlyArray<CommandCenterSection>>,
  sections: ReadonlyArray<CommandCenterSection>,
  assignments: ReadonlyArray<CommandCenterAssignment>,
  agents: ReadonlyArray<CommandCenterAgentProfile>,
): CommandCenterDependencyWire[] {
  const agentTeam = new Map(agents.map((agent) => [agent.id, agent.teamId] as const));
  const sectionTeam = new Map<string, { team: CommandCenterTeamId | null; at: string }>();
  for (const assignment of assignments) {
    if (assignment.sectionId === null) continue;
    const current = sectionTeam.get(assignment.sectionId);
    if (!current || current.at < assignment.createdAt) {
      sectionTeam.set(assignment.sectionId, {
        team: agentTeam.get(assignment.agentId) ?? null,
        at: assignment.createdAt,
      });
    }
  }
  return sections.flatMap((section) =>
    (unmet.get(section.id) ?? []).map((dependency) => ({
      section,
      dependency,
      from: sectionTeam.get(section.id)?.team ?? null,
      to: sectionTeam.get(dependency.id)?.team ?? null,
    })),
  );
}
