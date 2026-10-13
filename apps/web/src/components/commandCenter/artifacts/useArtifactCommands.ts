import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CommandCenterArtifact,
  CommandCenterArtifactImportInput,
  CommandCenterArtifactListInput,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../../ui/toast";
import { useCommandCenter } from "../shared";

/**
 * Artifact RPCs against the primary environment. Failures toast and resolve as `Failure`, so
 * callers only check `result._tag === "Success"`. `canWrite` gates every write control.
 */
export function useArtifactCommands() {
  const { primaryEnvironmentId, canOperate } = useCommandCenter();
  const permitted = useAtomValue(
    serverEnvironment.importCommandCenterArtifact.permissionAtom(primaryEnvironmentId),
  );
  const list = useAtomCommand(serverEnvironment.listCommandCenterArtifacts, {
    label: "command center list artifacts",
    reportFailure: false,
  });
  const importArtifact = useAtomCommand(serverEnvironment.importCommandCenterArtifact, {
    label: "command center import artifact",
    reportFailure: false,
  });
  const restore = useAtomCommand(serverEnvironment.restoreCommandCenterArtifactVersion, {
    label: "command center restore artifact",
    reportFailure: false,
  });
  const setArchived = useAtomCommand(serverEnvironment.setCommandCenterArtifactArchived, {
    label: "command center archive artifact",
    reportFailure: false,
  });
  return useMemo(() => {
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
    const environmentId = primaryEnvironmentId;
    const unarchive = (artifact: CommandCenterArtifact) =>
      setArchived({ environmentId, input: { id: artifact.id, archived: false } }).then(
        reportAs("Could not restore the artifact"),
      );
    return {
      canWrite: canOperate && permitted,
      list: (input: CommandCenterArtifactListInput) =>
        list({ environmentId, input }).then(reportAs("Could not load older artifacts")),
      import: (input: CommandCenterArtifactImportInput) =>
        importArtifact({ environmentId, input }).then(reportAs("Could not import the page")),
      restoreVersion: (artifact: CommandCenterArtifact, version: number) =>
        restore({ environmentId, input: { id: artifact.id, version } }).then(
          reportAs("Could not restore that version"),
        ),
      unarchive,
      /** Archives (the library's delete), then offers Undo. Resolves true once archived. */
      archiveWithUndo: async (artifact: CommandCenterArtifact) => {
        const result = await setArchived({
          environmentId,
          input: { id: artifact.id, archived: true },
        }).then(reportAs("Could not delete the artifact"));
        if (result._tag !== "Success") return false;
        const id = toastManager.add({
          type: "info",
          title: `Deleted ${artifact.title}`,
          description: "Find it later under Deleted.",
          actionProps: {
            children: "Undo",
            onClick: () => {
              toastManager.close(id);
              void unarchive(artifact);
            },
          },
        });
        return true;
      },
    };
  }, [canOperate, importArtifact, list, permitted, primaryEnvironmentId, restore, setArchived]);
}
