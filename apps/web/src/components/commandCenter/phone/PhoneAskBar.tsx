import type { ProjectId } from "@t3tools/contracts";
import { SendHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";
import { usePrimarySettings } from "~/hooks/useSettings";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { useAutoRouting } from "../plan/useAutoRouting";
import { pinnedFirst } from "../projects/projectDirectory";
import { type CommandCenterTarget, ORCHESTRATOR_INPUT_ID, useCommandCenter } from "../shared";

export function PhoneAskBar({
  draft,
  onDraftChange,
  target,
  onTargetChange,
  projectId,
  onProjectChange,
  busy,
  onSubmit,
  mic,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly target: CommandCenterTarget;
  readonly onTargetChange: (target: CommandCenterTarget) => void;
  readonly projectId: ProjectId | null;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly busy: boolean;
  readonly onSubmit: () => void;
  readonly mic?: ReactNode;
}) {
  const { projects } = useCommandCenter();
  const entries = usePrimarySettings((settings) => settings.commandCenter.projects);
  const { resolve, label, environments } = useAutoRouting();
  const route = resolve(projectId, null, target, null);
  const ordered = pinnedFirst(projects, entries);
  const chip = "min-w-0 max-w-[50%] rounded-md border bg-background px-2 py-1 text-xs";
  return (
    <form
      className="space-y-2 border-t bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex min-w-0 gap-2">
        <select
          className={chip}
          aria-label="Target machine"
          value={target}
          onChange={(event) =>
            onTargetChange(
              environments.find((environment) => environment.environmentId === event.target.value)
                ?.environmentId ?? "auto",
            )
          }
        >
          <option value="auto">Auto</option>
          {environments.map((environment) => (
            <option
              key={environment.environmentId}
              value={environment.environmentId}
              disabled={!environment.connected}
            >
              {environment.label}
              {environment.connected ? "" : " (offline)"}
            </option>
          ))}
        </select>
        <select
          className={chip}
          aria-label="Project focus"
          value={projectId ?? ""}
          onChange={(event) =>
            onProjectChange(
              projects.find((project) => project.id === event.target.value)?.id ?? null,
            )
          }
        >
          <option value="">Choose project</option>
          {ordered.map((project) => (
            <option key={`${project.environmentId}:${project.id}`} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <Input
            id={ORCHESTRATOR_INPUT_ID}
            aria-label="Ask the team"
            placeholder="Ask the team…"
            size="lg"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
          />
        </div>
        {mic}
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={busy || !draft.trim()}>
          <SendHorizontalIcon />
        </Button>
      </div>
      {projectId === null ? null : (
        <p className="truncate text-xs text-muted-foreground">
          {"error" in route
            ? route.error
            : `${target === "auto" ? "Auto" : "Route"} → ${label(route.environmentId)} (${route.reason})`}
        </p>
      )}
    </form>
  );
}
