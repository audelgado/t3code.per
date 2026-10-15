import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useContext, useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Textarea } from "../../ui/textarea";

/** Explicit-save editor against this project's environment, including remote workspaces. */
export function ProjectInstructions({ project }: { readonly project: EnvironmentProject }) {
  const registry = useContext(RegistryContext);
  const canWrite = useAtomValue(projectEnvironment.writeFile.permissionAtom(project.environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(project.environmentId));
  const openEditor = useOpenInPreferredEditor(
    project.environmentId,
    config?.availableEditors ?? [],
  );
  const write = useAtomCommand(projectEnvironment.writeFile, "save project instructions");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [original, setOriginal] = useState("");
  const [draft, setDraft] = useState("");
  const [missing, setMissing] = useState(false);
  const [large, setLarge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The textarea edits LF text; a CRLF file is written back with CRLF so git sees only real edits.
  const [crlf, setCrlf] = useState(false);
  const load = async () => {
    setBusy(true);
    setError(null);
    const result = await executeAtomQuery(
      registry,
      projectEnvironment.readFile({
        environmentId: project.environmentId,
        input: { cwd: project.workspaceRoot, relativePath: "AGENTS.md" },
      }),
      { refresh: true, reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Success") {
      const contents = result.value.contents.replace(/\r\n/g, "\n");
      setCrlf(contents !== result.value.contents);
      setOriginal(contents);
      setDraft(contents);
      setLarge(result.value.truncated || result.value.byteLength > 64 * 1024);
      setLoaded(true);
    } else {
      const cause = squashAtomCommandFailure(result);
      if (
        /ENOENT|NotFound|no such file|does not exist/i.test(String(cause) + JSON.stringify(cause))
      ) {
        setMissing(true);
        setLoaded(true);
      } else setError(String(cause));
    }
  };
  const save = async () => {
    if (!canWrite || large || busy) return;
    setBusy(true);
    const result = await write({
      environmentId: project.environmentId,
      input: {
        cwd: project.workspaceRoot,
        relativePath: "AGENTS.md",
        contents: crlf ? draft.replace(/\n/g, "\r\n") : draft,
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setOriginal(draft);
      setMissing(false);
      setError(null);
    } else setError(String(squashAtomCommandFailure(result)));
  };
  return (
    <Collapsible
      onOpenChange={(open) => {
        if (open && !loaded && !busy) void load();
      }}
    >
      <CollapsibleTrigger>Instructions (AGENTS.md)</CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-2 pt-3">
          {busy && !loaded ? (
            <p className="text-xs text-muted-foreground">Loading instructions…</p>
          ) : null}
          {error ? (
            <p role="status" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {loaded ? (
            <>
              <Textarea
                aria-label="Project instructions (AGENTS.md)"
                value={draft}
                readOnly={!canWrite || large}
                onChange={(event) => setDraft(event.target.value)}
              />
              {large ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    This file is over 64 KB. Edit it in your editor.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void openEditor(`${project.workspaceRoot.replace(/[\\/]+$/, "")}/AGENTS.md`)
                    }
                  >
                    Open in editor
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    disabled={!canWrite || busy || (!missing && draft === original)}
                    title={!canWrite ? "Filesystem write permission is required." : undefined}
                    onClick={() => void save()}
                  >
                    {missing ? "Create AGENTS.md" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || draft === original}
                    onClick={() => setDraft(original)}
                  >
                    Revert
                  </Button>
                  {!canWrite ? (
                    <p className="text-xs text-muted-foreground">
                      Filesystem write permission is required.
                    </p>
                  ) : null}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Changes are written only when you save.
              </p>
            </>
          ) : error ? (
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
