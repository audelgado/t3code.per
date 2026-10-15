import { useAtomValue } from "@effect/atom-react";
import type { CommandCenterAgentProfile, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "~/state/server";
import { useAgentStates, useCommandCenter, useCommandCenterEnvironments } from "../shared";
import { activeAssignmentsByMachine, checkAgentProvider, resolveAutoMachine } from "./planLogic";

/** Shares routing inputs between previews and launches, without grouping independent clones. */
export function useAutoRouting() {
  const { projects, primaryEnvironmentId } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const states = useAgentStates();
  const counts = activeAssignmentsByMachine(states.values());
  const providersAtom = useMemo(
    () =>
      Atom.make(
        (get) =>
          new Map(
            environments.map(
              ({ environmentId }) =>
                [environmentId, get(serverEnvironment.providersValueAtom(environmentId))] as const,
            ),
          ),
      ),
    [environments],
  );
  const providers = useAtomValue(providersAtom);
  const label = (environmentId: EnvironmentId) =>
    environments.find((entry) => entry.environmentId === environmentId)?.label ?? "Unknown machine";
  const selectedProject = (projectId: ProjectId | null) =>
    projects.find((project) => project.id === projectId);
  const resolve = (
    projectId: ProjectId | null,
    agent: CommandCenterAgentProfile | null,
    explicit: EnvironmentId | "auto",
    teamMachine: EnvironmentId | null,
  ) => {
    const project = selectedProject(projectId);
    return resolveAutoMachine({
      explicit,
      primary: primaryEnvironmentId,
      teamMachine,
      candidates: environments.map((environment) => ({
        ...environment,
        // There is no explicit cross-machine association in CC settings yet. The selected
        // environment-local project is the sole authoritative location; remotes are not identity.
        hasProject: project?.environmentId === environment.environmentId,
        providerOk:
          !agent ||
          checkAgentProvider(
            agent.modelSelection,
            providers.get(environment.environmentId) ?? null,
            environment.label,
          )?.level !== "error",
        activeAssignments: counts.get(environment.environmentId) ?? 0,
      })),
    });
  };
  return { resolve, label, environments, counts, providers, states };
}
