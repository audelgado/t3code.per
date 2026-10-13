import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../../../ui/toast";
import type { TextRewrite } from "./TextOptimizer";

/**
 * "Rewrite shorter" for a project's prompts and skills, on the project's text generation model.
 * Undefined when the grant does not allow it, which hides the button.
 */
export function useTextRewrite(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): TextRewrite | undefined {
  const permitted = useAtomValue(
    serverEnvironment.rewriteCommandCenterText.permissionAtom(environmentId),
  );
  const rewrite = useAtomCommand(serverEnvironment.rewriteCommandCenterText, {
    label: "command center rewrite text",
    reportFailure: false,
  });
  return useMemo(() => {
    if (!permitted) return undefined;
    return async (text, kind) => {
      const result = await rewrite({ environmentId, input: { projectId, kind, text } });
      if (result._tag === "Success") return result.value.text;
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not rewrite the text",
          description: String(squashAtomCommandFailure(result)),
        });
      }
      return null;
    };
  }, [environmentId, permitted, projectId, rewrite]);
}
