import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowAnswerStepInput,
  CommandCenterWorkflowRetryStepInput,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowSlug,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../../ui/toast";

const reportAs =
  (title: string) =>
  <A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title,
        description: String(squashAtomCommandFailure(result)),
      });
    }
    return result;
  };

/**
 * Workflow RPCs against the environment that has the project (files and runs live there).
 * Failures toast and resolve as `Failure`. `canWrite` gates file edits, `canRun` run control.
 */
export function useWorkflowCommands(environmentId: EnvironmentId, projectId: ProjectId) {
  const canWrite = useAtomValue(
    serverEnvironment.saveCommandCenterWorkflow.permissionAtom(environmentId),
  );
  const canRun = useAtomValue(
    serverEnvironment.startCommandCenterWorkflowRun.permissionAtom(environmentId),
  );
  const options = (label: string) => ({ label, reportFailure: false });
  const save = useAtomCommand(
    serverEnvironment.saveCommandCenterWorkflow,
    options("save workflow"),
  );
  const remove = useAtomCommand(
    serverEnvironment.deleteCommandCenterWorkflow,
    options("delete workflow"),
  );
  const restore = useAtomCommand(
    serverEnvironment.restoreCommandCenterWorkflow,
    options("restore workflow"),
  );
  const start = useAtomCommand(
    serverEnvironment.startCommandCenterWorkflowRun,
    options("start workflow run"),
  );
  const stop = useAtomCommand(serverEnvironment.stopCommandCenterWorkflowRun, options("stop run"));
  const retry = useAtomCommand(
    serverEnvironment.retryCommandCenterWorkflowStep,
    options("retry step"),
  );
  const resume = useAtomCommand(
    serverEnvironment.resumeCommandCenterWorkflowRun,
    options("resume run"),
  );
  const answer = useAtomCommand(
    serverEnvironment.answerCommandCenterWorkflowStep,
    options("answer workflow step"),
  );

  return useMemo(() => {
    const restoreSlug = (slug: CommandCenterWorkflowSlug) =>
      restore({ environmentId, input: { projectId, slug } }).then(
        reportAs("Could not restore the workflow"),
      );
    return {
      canWrite,
      canRun,
      save: (workflow: CommandCenterWorkflow) =>
        save({ environmentId, input: { projectId, workflow } }).then(
          reportAs("Could not save the workflow"),
        ),
      restore: restoreSlug,
      /** Moves the file to the trash, then offers Undo. Resolves true once deleted. */
      removeWithUndo: async (slug: CommandCenterWorkflowSlug, title: string) => {
        const result = await remove({ environmentId, input: { projectId, slug } }).then(
          reportAs("Could not delete the workflow"),
        );
        if (result._tag !== "Success") return false;
        const id = toastManager.add({
          type: "info",
          title: `Deleted ${title}`,
          description: "Find it later under Deleted.",
          actionProps: {
            children: "Undo",
            onClick: () => {
              toastManager.close(id);
              void restoreSlug(slug);
            },
          },
        });
        return true;
      },
      start: (slug: CommandCenterWorkflowSlug, inputs: Record<string, string>) =>
        start({ environmentId, input: { projectId, slug, inputs } }).then(
          reportAs("Could not start the workflow"),
        ),
      stop: (runId: CommandCenterWorkflowRunId) =>
        stop({ environmentId, input: { runId } }).then(reportAs("Could not stop the run")),
      retry: (input: CommandCenterWorkflowRetryStepInput) =>
        retry({ environmentId, input }).then(reportAs("Could not retry the step")),
      resume: (runId: CommandCenterWorkflowRunId) =>
        resume({ environmentId, input: { runId } }).then(reportAs("Could not resume the run")),
      answer: (input: CommandCenterWorkflowAnswerStepInput) =>
        answer({ environmentId, input }).then(reportAs("Could not answer the step")),
    };
  }, [
    answer,
    canRun,
    canWrite,
    environmentId,
    projectId,
    remove,
    restore,
    resume,
    retry,
    save,
    start,
    stop,
  ]);
}

export type WorkflowCommands = ReturnType<typeof useWorkflowCommands>;
