import type {
  CommandCenterAgentId,
  CommandCenterAgentProfile,
  CommandCenterAssignment,
  CommandCenterMemoryEntry,
  CommandCenterSection,
  CommandCenterTeam,
  CommandCenterTeamId,
} from "@t3tools/contracts";

import { paginateCollection } from "../collectionPaging";

/**
 * Machine column of an agent without a team: where its latest assignment ran, else the primary
 * environment (as for a team without a machine). Machines no client knows share "unknown".
 */
export function agentMachineKey(
  assignment: Pick<CommandCenterAssignment, "environmentId"> | null,
  primaryEnvironmentId: string,
  knownMachineIds: ReadonlySet<string>,
) {
  const key = assignment?.environmentId ?? primaryEnvironmentId;
  return knownMachineIds.has(key) ? key : "unknown";
}

export function matchesAgentSearch(
  agent: Pick<CommandCenterAgentProfile, "name" | "role">,
  task: string | null | undefined,
  query: string,
) {
  return `${agent.name} ${agent.role} ${task ?? ""}`
    .toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase());
}

/** Keep the lead in view while finding and paging the rest of a team's members. */
export function selectTeamMemberPage<
  T extends Pick<CommandCenterAgentProfile, "id" | "name" | "role">,
>(
  members: ReadonlyArray<T>,
  leadAgentId: CommandCenterAgentId | null,
  query: string,
  page: number,
  taskOf: (agent: T) => string | null | undefined,
) {
  const matching = members.filter((agent) => matchesAgentSearch(agent, taskOf(agent), query));
  // A team or machine name can match without any member matching. Retain that team's roster.
  const visible = query.trim() !== "" && matching.length > 0 ? matching : members;
  const lead = members.find((agent) => agent.id === leadAgentId) ?? null;
  return {
    ...paginateCollection(
      visible.filter((agent) => agent.id !== leadAgentId),
      page,
      10,
    ),
    lead,
  };
}

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
