import {
  buildOnboardingPrompt,
  latestHandoffs,
  onboardingTask,
} from "@t3tools/client-runtime/command-center-delegation";
import { COMMAND_CENTER_ONBOARDING_LEAD_ID, type ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useProjects } from "~/state/entities";
import { toastManager } from "../../ui/toast";
import { useCommandCenter, useCommandCenterCommands } from "../shared";
import { useStartAgentThread } from "./useStartAgentThread";

/**
 * `startOnboarding(projectId)`: makes sure the Onboarding team exists, refreshes the repo
 * digest (0 tokens), then starts the Lead's thread for that project. The Lead's role prompt
 * runs Scout, Organizer and the interview from there. Resolves true once the thread exists.
 * Used by the orchestrator bar (`onboard [project]`) and the Projects tab; call it once per
 * page, not per card.
 *
 * Runs on the primary machine only: onboarding is all memory and digest work, and the memory
 * tools answer only on the machine that holds Command Center.
 */
export function useStartOnboarding() {
  const { snapshot, primaryEnvironmentId, projects } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const allProjects = useProjects();
  const startAgentThread = useStartAgentThread();
  return useCallback(
    async (projectId: ProjectId): Promise<boolean> => {
      const fail = (title: string) => {
        toastManager.add({ type: "error", title });
        return false;
      };
      const onPrimary = allProjects.some(
        (project) => project.environmentId === primaryEnvironmentId && project.id === projectId,
      );
      if (!onPrimary) {
        return fail(
          "Onboarding runs on the machine that holds Command Center; add the project there",
        );
      }
      const ensured = await commands.ensureOnboardingTeam();
      if (ensured._tag !== "Success") return false;
      const lead = ensured.value.agents.find(
        (agent) => agent.id === COMMAND_CENTER_ONBOARDING_LEAD_ID,
      );
      if (!lead) return fail("The Onboarding team has no Lead agent");
      // The digest is a head start; if the scan fails (already toasted), the Lead's
      // project_digest tool builds it on demand.
      await commands.buildRepoDigest({ projectId });
      const title = projects.find((project) => project.id === projectId)?.title ?? "this project";
      const recalled = await commands.recallMemory(projectId);
      // Same prompt as `t3 cc onboard`. Onboarding only reads and writes memory, so it runs in
      // the project checkout, not a worktree.
      const threadId = await startAgentThread({
        environmentId: primaryEnvironmentId,
        projectId,
        agent: lead,
        task: onboardingTask(title),
        prompt: buildOnboardingPrompt({
          rolePrompt: lead.rolePrompt,
          projectTitle: title,
          handoffs: latestHandoffs(
            recalled._tag === "Success" ? recalled.value.handoffs : snapshot.memory,
            projectId,
          ),
        }),
      });
      if (threadId === null) return false;
      toastManager.add({ type: "success", title: "Onboarding started", description: title });
      return true;
    },
    [allProjects, commands, primaryEnvironmentId, projects, snapshot.memory, startAgentThread],
  );
}
