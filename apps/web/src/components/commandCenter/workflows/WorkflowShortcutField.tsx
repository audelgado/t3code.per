import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { CommandCenterWorkflowSlug, EnvironmentId } from "@t3tools/contracts";
import { useState, type KeyboardEvent } from "react";

import {
  decodeProjectScriptKeybindingRule,
  keybindingValueForCommand,
} from "~/lib/projectScriptKeybindings";
import { useEnvironments } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { commandForWorkflow } from "~/workflowCommand";
import { Input } from "../../ui/input";
import { toastManager } from "../../ui/toast";
import { keybindingFromKeyboardEvent } from "../../settings/KeybindingsSettings.logic";
import { Field } from "./NodePanel";

/**
 * A keyboard shortcut that runs this workflow in the active project (`workflow.<slug>.run`),
 * saved to the environment's keybindings like a project action's.
 */
export function WorkflowShortcutField({
  environmentId,
  slug,
}: {
  readonly environmentId: EnvironmentId;
  readonly slug: CommandCenterWorkflowSlug;
}) {
  const { environments } = useEnvironments();
  const keybindings =
    environments.find((entry) => entry.environmentId === environmentId)?.serverConfig
      ?.keybindings ?? [];
  const command = commandForWorkflow(slug);
  const current = keybindingValueForCommand(keybindings, command);
  const canWrite = useAtomValue(serverEnvironment.upsertKeybinding.permissionAtom(environmentId));
  const upsert = useAtomCommand(serverEnvironment.upsertKeybinding, {
    label: "workflow shortcut",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.removeKeybinding, {
    label: "workflow shortcut",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  if (command === null) return null;

  const apply = async (next: string | null) => {
    const previous = decodeProjectScriptKeybindingRule({ keybinding: current, command });
    let rule: ReturnType<typeof decodeProjectScriptKeybindingRule>;
    try {
      rule = decodeProjectScriptKeybindingRule({ keybinding: next, command });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: String(error instanceof Error ? error.message : error),
      });
      return;
    }
    if (rule === null && previous === null) return;
    setSaving(true);
    const result =
      rule === null
        ? previous === null
          ? null
          : await remove({ environmentId, input: previous })
        : await upsert({
            environmentId,
            input:
              previous !== null && previous.key !== rule.key
                ? { ...rule, replace: previous }
                : rule,
          });
    setSaving(false);
    if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not save the shortcut",
        description: String(squashAtomCommandFailure(result)),
      });
    }
  };

  const capture = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    // Not the editor's own Ctrl+S or undo.
    event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") {
      void apply(null);
      return;
    }
    const next = keybindingFromKeyboardEvent(event, navigator.platform);
    if (next !== null) void apply(next);
  };

  return (
    <Field
      label="Shortcut"
      hint="Runs this workflow in the active project. Backspace clears it. Shortcuts apply on every project of this environment."
    >
      <Input
        readOnly
        placeholder="Press a shortcut"
        value={current ?? ""}
        disabled={!canWrite || saving}
        onKeyDown={capture}
      />
    </Field>
  );
}
