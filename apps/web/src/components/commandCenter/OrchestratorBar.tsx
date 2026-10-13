import type { ProjectId } from "@t3tools/contracts";
import { SendHorizontalIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  type CommandCenterTarget,
  ORCHESTRATOR_INPUT_ID,
  useCommandCenter,
  useCommandCenterEnvironments,
} from "./shared";

const NO_PROJECT = "__none";

/** One input for the whole team. `remember:` text is saved to memory; anything else opens a plan. */
export function OrchestratorBar({
  draft,
  onDraftChange,
  projectId,
  onProjectChange,
  target,
  onTargetChange,
  busy,
  onSubmit,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly projectId: ProjectId | null;
  readonly onProjectChange: (projectId: ProjectId | null) => void;
  readonly target: CommandCenterTarget;
  readonly onTargetChange: (target: CommandCenterTarget) => void;
  readonly busy: boolean;
  readonly onSubmit: () => void;
}) {
  const { projects } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const selectedProject = projects.find((project) => project.id === projectId);
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={ORCHESTRATOR_INPUT_ID}
            aria-label="Ask the orchestrator"
            placeholder="Ask the team, or start with remember: to save a note"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
          />
        </div>
        <Kbd className="max-sm:hidden">/</Kbd>
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={busy || !draft.trim()}>
          <SendHorizontalIcon />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-48 max-sm:w-full">
          <Select
            value={projectId ?? NO_PROJECT}
            onValueChange={(value) =>
              onProjectChange(projects.find((project) => project.id === value)?.id ?? null)
            }
          >
            <SelectTrigger aria-label="Project" size="sm">
              <SelectValue>{selectedProject?.title ?? "No project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_PROJECT}>No project</SelectItem>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="max-w-full overflow-x-auto">
          <ToggleGroup
            aria-label="Target machine"
            variant="segmented"
            value={[target]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === undefined) return;
              onTargetChange(
                environments.find((environment) => environment.environmentId === value)
                  ?.environmentId ?? "auto",
              );
            }}
          >
            <Toggle value="auto">Auto</Toggle>
            {environments.map((environment) => (
              <Toggle
                key={environment.environmentId}
                value={environment.environmentId}
                disabled={!environment.connected}
                title={environment.connected ? environment.label : `${environment.label} (offline)`}
              >
                {environment.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </div>
    </form>
  );
}
