import { SendHorizontalIcon } from "lucide-react";
import { DictationButton } from "../dictation/DictationButton";
import { insertIntoInput } from "../dictation/webDictation";

import { parseWorkflowCommand, workflowCommandSuggestions } from "~/workflowCommand";
import { useWorkflowChoices } from "../RunWorkflowDialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { guessTeamForStep, splitRequestIntoSteps } from "./plan/planLogic";
import { useAutoRouting } from "./plan/useAutoRouting";
import { type CommandCenterTarget, ORCHESTRATOR_INPUT_ID, useCommandCenter } from "./shared";

const WORKFLOW_OPTIONS_ID = `${ORCHESTRATOR_INPUT_ID}-workflows`;

/**
 * One input for the whole team, on the page's project focus. `remember:` text is saved to memory,
 * `/wf <slug>` runs a workflow, and anything else opens a plan.
 */
export function OrchestratorBar({
  draft,
  onDraftChange,
  target,
  onTargetChange,
  busy,
  onSubmit,
}: {
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly target: CommandCenterTarget;
  readonly onTargetChange: (target: CommandCenterTarget) => void;
  readonly busy: boolean;
  readonly onSubmit: () => void;
}) {
  const { projects, projectId, snapshot, primaryEnvironmentId } = useCommandCenter();
  const routing = useAutoRouting();
  const environments = routing.environments;
  const selectedProject = projects.find((project) => project.id === projectId);
  const teams = snapshot.teams.filter((team) => team.archivedAt === null);
  const agents = snapshot.agentProfiles.filter((agent) => agent.archivedAt === null);
  const teamId = guessTeamForStep(splitRequestIntoSteps(draft)[0] ?? "", teams, agents);
  const team = teams.find((entry) => entry.id === teamId);
  const agent =
    agents.find(
      (entry) =>
        entry.teamId === teamId && (routing.states.get(entry.id)?.status ?? "idle") === "idle",
    ) ?? null;
  const route = routing.resolve(
    projectId,
    agent,
    target,
    team?.environmentId ?? primaryEnvironmentId,
  );
  // The project's workflows are fetched only while a slash command is being typed.
  const slashing = draft.trimStart().startsWith("/");
  const { choices } = useWorkflowChoices(
    selectedProject?.environmentId ?? null,
    selectedProject?.id ?? null,
    slashing,
  );
  const suggestions = slashing ? workflowCommandSuggestions(draft, choices) : [];
  const workflowCommand = slashing ? parseWorkflowCommand(draft) : null;
  const workflow = workflowCommand
    ? choices.find((choice) => choice.slug === workflowCommand.slug)
    : undefined;
  const workflowHint =
    workflowCommand === null
      ? null
      : selectedProject === undefined
        ? "Set the project focus to run a workflow in."
        : workflow
          ? [
              workflow.title,
              workflow.inputs.length === 0
                ? "no inputs"
                : workflow.inputs
                    .map((input) =>
                      input.default?.trim()
                        ? `${input.name}=${input.default}`
                        : `${input.name} (required)`,
                    )
                    .join(", "),
            ].join(" · ")
          : "Type a workflow name, then name=value inputs or free text. Missing inputs are asked for.";
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
            aria-label="Ask the team"
            placeholder="Ask the team, remember: a note, or /wf to run a workflow"
            value={draft}
            list={WORKFLOW_OPTIONS_ID}
            autoComplete="off"
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <datalist id={WORKFLOW_OPTIONS_ID}>
            {suggestions.map((suggestion) => (
              <option key={suggestion.value} value={suggestion.value} label={suggestion.label} />
            ))}
          </datalist>
        </div>
        <Kbd className="max-sm:hidden">/</Kbd>
        <DictationButton
          onText={(text) => onDraftChange(insertIntoInput(ORCHESTRATOR_INPUT_ID, draft, text))}
        />
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={busy || !draft.trim()}>
          <SendHorizontalIcon />
        </Button>
      </div>
      {workflowHint ? (
        <p className="truncate text-xs text-muted-foreground" role="status">
          {workflowHint}
        </p>
      ) : null}
      {selectedProject && !slashing ? (
        <p className="text-xs text-muted-foreground" role="status">
          {"error" in route
            ? route.error
            : `${target === "auto" ? "Auto" : "Route"} → ${routing.label(route.environmentId)}${agent ? ` · ${agent.name}` : " · pick an agent in Plan"}`}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {selectedProject ? `For ${selectedProject.title}` : "No project focus"}
        </span>
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
