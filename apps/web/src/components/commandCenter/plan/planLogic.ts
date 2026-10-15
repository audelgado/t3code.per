import {
  COMMAND_CENTER_ONBOARDING_TEAM_ID,
  isProviderAvailable,
  type CommandCenterAgentProfile,
  type CommandCenterAssignment,
  type CommandCenterTeam,
  type CommandCenterTeamId,
  type EnvironmentId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

// Commas, semicolons, new lines, and the connectives "and" / "y". Steps start together, so an
// ordered "and then" / "y luego" is not split: that work stays in one thread, in order.
// `\b` misses accented letters, so words are bounded by whitespace or the string ends.
const STEP_SEPARATOR = /[,;\n]|(?:^|\s+)(?:and|y)(?=\s|$)(?!\s+(?:then|luego)(?:\s|$))/giu;

/**
 * Splits an orchestrator request into parallel steps. Deterministic and free: no model call.
 * `ponytail:` naive split, so "search and replace" becomes two steps; the plan drawer lets the
 * user merge them back. Upgrade path is the LLM orchestrator.
 */
export function splitRequestIntoSteps(request: string): string[] {
  return request
    .split(STEP_SEPARATOR)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

// Short filler words that would otherwise match any team ("the", "and", "con", "para").
const STOPWORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "new",
  "add",
  "fix",
  "make",
  "con",
  "del",
  "los",
  "las",
  "por",
  "para",
  "que",
  "una",
]);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));

/**
 * Picks the team whose name or members' roles share the most words with the step.
 * Returns null when nothing matches; ties go to the earlier team. The Onboarding team only
 * runs `onboard`, so it is never guessed.
 */
export function guessTeamForStep(
  step: string,
  teams: ReadonlyArray<CommandCenterTeam>,
  agents: ReadonlyArray<CommandCenterAgentProfile>,
): CommandCenterTeamId | null {
  const stepWords = new Set(words(step));
  let best: { id: CommandCenterTeamId; score: number } | null = null;
  for (const team of teams) {
    if (team.archivedAt !== null || team.id === COMMAND_CENTER_ONBOARDING_TEAM_ID) continue;
    const keywords = new Set([
      ...words(team.name),
      ...agents
        .filter((agent) => agent.teamId === team.id && agent.archivedAt === null)
        .flatMap((agent) => words(agent.role)),
    ]);
    let score = 0;
    for (const keyword of keywords) {
      if (stepWords.has(keyword)) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) best = { id: team.id, score };
  }
  return best?.id ?? null;
}

/** Machine a step runs on: an explicit pick, else (Auto) its team's machine, else the primary. */
export function resolveStepMachine(
  machine: EnvironmentId | "auto",
  team: Pick<CommandCenterTeam, "environmentId"> | undefined,
  primaryEnvironmentId: EnvironmentId,
): EnvironmentId {
  if (machine !== "auto") return machine;
  return team?.environmentId ?? primaryEnvironmentId;
}

export interface AutoMachineCandidate {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  /** An explicit association with this project; never inferred from a remote or title. */
  readonly hasProject: boolean;
  readonly providerOk: boolean;
  readonly activeAssignments: number;
}

/** Resolves a route from the same candidates used for previews and starting work. */
export function resolveAutoMachine({
  explicit,
  candidates,
  teamMachine,
  primary,
}: {
  readonly explicit: EnvironmentId | "auto" | null;
  readonly candidates: ReadonlyArray<AutoMachineCandidate>;
  readonly teamMachine: EnvironmentId | null;
  readonly primary: EnvironmentId;
}):
  | {
      readonly environmentId: EnvironmentId;
      readonly reason: "explicit" | "only" | "team" | "least-busy";
    }
  | { readonly error: string } {
  const eligible = candidates.filter(
    (candidate) => candidate.connected && candidate.hasProject && candidate.providerOk,
  );
  if (explicit !== null && explicit !== "auto") {
    const picked = candidates.find((candidate) => candidate.environmentId === explicit);
    if (!picked?.connected) return { error: "The selected machine is offline." };
    if (!picked.hasProject)
      return { error: "This project is not associated with the selected machine." };
    if (!picked.providerOk)
      return { error: "The agent's provider is not available on the selected machine." };
    return { environmentId: explicit, reason: "explicit" };
  }
  if (eligible.length === 0) {
    if (!candidates.some((candidate) => candidate.connected))
      return { error: "No machines are connected." };
    if (!candidates.some((candidate) => candidate.connected && candidate.hasProject))
      return { error: "This project has no associated copy on a connected machine." };
    return {
      error: "The agent's provider is not available on a connected machine with this project.",
    };
  }
  if (eligible.length === 1) return { environmentId: eligible[0]!.environmentId, reason: "only" };
  if (teamMachine !== null && eligible.some((candidate) => candidate.environmentId === teamMachine))
    return { environmentId: teamMachine, reason: "team" };
  const picked = eligible.reduce((best, candidate) =>
    candidate.activeAssignments < best.activeAssignments ||
    (candidate.activeAssignments === best.activeAssignments && candidate.environmentId === primary)
      ? candidate
      : best,
  );
  return { environmentId: picked.environmentId, reason: "least-busy" };
}

/** Counts only unfinished assignments whose streamed agent state is working. */
export function activeAssignmentsByMachine(
  states: Iterable<{
    readonly status: string;
    readonly assignment: Pick<CommandCenterAssignment, "environmentId" | "finishedAt"> | null;
  }>,
): ReadonlyMap<EnvironmentId, number> {
  const counts = new Map<EnvironmentId, number>();
  for (const { status, assignment } of states) {
    if (status !== "working" || assignment === null || assignment.finishedAt !== null) continue;
    counts.set(assignment.environmentId, (counts.get(assignment.environmentId) ?? 0) + 1);
  }
  return counts;
}

export interface ProviderIssue {
  /** `error` blocks starting; `warning` is shown but the step can still start. */
  readonly level: "error" | "warning";
  readonly message: string;
}

/**
 * Whether the agent's provider instance and model can run on a machine, from the provider list
 * the client already streams. `providers` null means not loaded yet, which is not an issue.
 */
export function checkAgentProvider(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider> | null,
  machineLabel: string,
): ProviderIssue | null {
  if (providers === null) return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  const name = provider?.displayName ?? selection.instanceId;
  if (!provider) return { level: "error", message: `${name} is not set up on ${machineLabel}.` };
  if (!provider.enabled)
    return { level: "error", message: `${name} is turned off on ${machineLabel}.` };
  if (!provider.installed || !isProviderAvailable(provider)) {
    return { level: "error", message: `${name} is not available on ${machineLabel}.` };
  }
  const known = provider.models.some(
    (model) => model.slug === selection.model || model.aliases?.includes(selection.model),
  );
  // Custom models live in settings, not the provider list, so an unknown slug only warns.
  if (!known && provider.models.length > 0) {
    return {
      level: "warning",
      message: `${name} on ${machineLabel} does not list model ${selection.model}.`,
    };
  }
  return null;
}
