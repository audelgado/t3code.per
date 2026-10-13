import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandCenterSnippetName,
  type CommandCenterWorkflow,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { BlocksIcon } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../../../ui/button";
import { toastManager } from "../../../ui/toast";
import { extractWorkflowSnippet } from "./textLogic";

/**
 * Shown when several agent prompts share a paragraph: saves it as a project snippet and hands
 * back the workflow with `{{snippet:name}}` in its place. The caller saves the workflow.
 */
export function SharedSnippetButton({
  environmentId,
  projectId,
  workflow,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workflow: CommandCenterWorkflow;
  readonly onChange: (next: CommandCenterWorkflow) => void;
}) {
  const registry = useContext(RegistryContext);
  const permitted = useAtomValue(
    serverEnvironment.saveCommandCenterSnippet.permissionAtom(environmentId),
  );
  const saveSnippet = useAtomCommand(serverEnvironment.saveCommandCenterSnippet, {
    label: "command center save snippet",
    reportFailure: false,
  });
  const candidate = useMemo(() => extractWorkflowSnippet(workflow, new Set()), [workflow]);
  const [saving, setSaving] = useState(false);
  if (candidate === null || !permitted) return null;

  const fail = (description: string) =>
    toastManager.add({ type: "error", title: "Could not create the snippet", description });

  const extract = async () => {
    setSaving(true);
    try {
      // Read the names at click time so a new snippet never overwrites an existing one.
      const listed = await executeAtomQuery(
        registry,
        serverEnvironment.commandCenterSnippets({ environmentId, input: { projectId } }),
        { refresh: true, reportFailure: false },
      );
      if (listed._tag !== "Success") {
        if (!isAtomCommandInterrupted(listed)) fail(String(squashAtomCommandFailure(listed)));
        return;
      }
      const result = extractWorkflowSnippet(
        workflow,
        new Set(listed.value.snippets.map((snippet) => snippet.name)),
      );
      if (result === null) return;
      const saved = await saveSnippet({
        environmentId,
        input: {
          projectId,
          name: CommandCenterSnippetName.make(result.name),
          content: result.content,
        },
      });
      if (saved._tag !== "Success") {
        if (!isAtomCommandInterrupted(saved)) fail(String(squashAtomCommandFailure(saved)));
        return;
      }
      onChange(result.workflow);
      toastManager.add({
        type: "success",
        title: `Moved shared text to {{snippet:${result.name}}}`,
        description: `Used by ${result.uses} prompts. Edit it once under .t3/workflows/snippets.`,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      variant="ghost-muted"
      size="xs"
      disabled={saving}
      title={`${candidate.uses} prompts repeat the same paragraph`}
      onClick={() => void extract()}
    >
      <BlocksIcon />
      Share repeated text
    </Button>
  );
}
