import {
  delegationBranchName,
  delegationWorktreeBootstrap,
} from "@t3tools/client-runtime/command-center-delegation";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  CommandCenterAgentProfile,
  CommandCenterSectionId,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { readProject, waitForThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { toastManager } from "../../ui/toast";
import { useCommandCenterCommands } from "../shared";

export interface StartAgentThreadInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly agent: CommandCenterAgentProfile;
  /** Short task text: thread title and the assignment's task. */
  readonly task: string;
  /** Full first message, usually from `buildStepPrompt`. */
  readonly prompt: string;
  readonly sectionId?: CommandCenterSectionId | null;
  /** Run in a new worktree off the project checkout instead of the checkout itself. */
  readonly worktree?: boolean;
}

/**
 * Starts a thread for a Command Center agent with the profile's provider, model and modes (and,
 * with `worktree`, in its own worktree so parallel steps never share files), then
 * records the assignment in the primary environment. Resolves the thread id once the thread
 * exists (even if the assignment write fails, which already toasts), or null when it did not
 * start. A failed start whose thread shows up anyway (a timeout after the server committed)
 * still counts as started, so a retry never runs the step twice. Used by the plan drawer and
 * the onboarding flow.
 */
export function useStartAgentThread() {
  const commands = useCommandCenterCommands();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, "delegate step");
  return useCallback(
    async ({
      environmentId,
      projectId,
      agent,
      task,
      prompt,
      sectionId = null,
      worktree = false,
    }: StartAgentThreadInput): Promise<ThreadId | null> => {
      const project = readProject({ environmentId, projectId });
      if (project === null) {
        toastManager.add({ type: "error", title: "This project is not on that machine" });
        return null;
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const text = task.trim();
      const title = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: prompt, attachments: [] },
          modelSelection: agent.modelSelection,
          // No titleSeed: the task already is the title, so no model call renames the thread.
          runtimeMode: agent.runtimeMode,
          interactionMode: agent.interactionMode,
          bootstrap: {
            createThread: {
              projectId,
              title,
              modelSelection: agent.modelSelection,
              runtimeMode: agent.runtimeMode,
              interactionMode: agent.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
            ...delegationWorktreeBootstrap({
              worktree,
              projectCwd: project.workspaceRoot,
              branch: delegationBranchName(agent.name, text, threadId),
            }),
          },
          createdAt,
        },
      });
      if (
        result._tag !== "Success" &&
        !(await waitForThreadShell(scopeThreadRef(environmentId, threadId), 3_000))
      ) {
        return null;
      }
      await commands.upsert({
        entity: "assignment",
        value: {
          agentId: agent.id,
          environmentId,
          threadId,
          projectId,
          sectionId,
          task: text,
          finishedAt: null,
        },
      });
      return threadId;
    },
    [commands, startTurn],
  );
}
