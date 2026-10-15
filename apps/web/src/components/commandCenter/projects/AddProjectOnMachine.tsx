import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { newProjectId } from "~/lib/utils";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { useCommandCenterEnvironments } from "../shared";

function Destination({
  project,
  environmentId,
  label,
}: {
  readonly project: EnvironmentProject;
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const base = useEnvironmentSettings(
    environmentId,
    (settings) => settings.addProjectBaseDirectory,
  );
  const [path, setPath] = useState(
    () =>
      `${(base || "~").replace(/[\\/]+$/, "")}/${project.repositoryIdentity?.name ?? project.title}`,
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const allowed = useAtomValue(
    sourceControlEnvironment.startProjectClone.permissionAtom(environmentId),
  );
  const clone = useAtomCommand(
    sourceControlEnvironment.startProjectClone,
    "clone project on machine",
  );
  const remoteUrl = project.repositoryIdentity?.locator.remoteUrl;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            disabled={!allowed || !remoteUrl}
            title={
              !remoteUrl
                ? "Publish to GitHub first"
                : !allowed
                  ? "Source control write permission is required."
                  : undefined
            }
          />
        }
      >
        Add on {label}
      </PopoverTrigger>
      <PopoverPopup>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !allowed || !remoteUrl || !path.trim()) return;
            setBusy(true);
            void clone({
              environmentId,
              input: {
                projectId: newProjectId(),
                title: project.title,
                createdAt: new Date().toISOString(),
                remoteUrl,
                destinationPath: path.trim(),
              },
            }).then((result) => {
              setBusy(false);
              if (result._tag === "Success") setOpen(false);
            });
          }}
        >
          <p className="text-sm font-medium">
            Add {project.title} on {label}
          </p>
          <p className="text-xs text-muted-foreground">
            Creates an independent project. Its pins, groups and work stay separate.
          </p>
          <Input
            aria-label="Clone destination"
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !allowed || !path.trim()}>
            {busy ? "Starting clone…" : "Clone project"}
          </Button>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

/** The user explicitly chooses a destination; sharing a remote never associates projects. */
export function AddProjectOnMachine({ project }: { readonly project: EnvironmentProject }) {
  const machines = useCommandCenterEnvironments().filter(
    (machine) => machine.connected && machine.environmentId !== project.environmentId,
  );
  if (machines.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {machines.map((machine) => (
        <Destination
          key={machine.environmentId}
          project={project}
          environmentId={machine.environmentId}
          label={machine.label}
        />
      ))}
    </div>
  );
}
