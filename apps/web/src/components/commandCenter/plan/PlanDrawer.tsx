import {
  artifactReferenceIds,
  buildStepPrompt,
  latestHandoffs,
  type StepArtifact,
} from "@t3tools/client-runtime/command-center-delegation";
import {
  CommandCenterArtifactId,
  type CommandCenterAgentId,
  type CommandCenterSectionId,
  type CommandCenterTeamId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { readProject } from "~/state/entities";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { ProjectPicker } from "../ProjectPicker";
import {
  type CommandCenterPlanSeed,
  type CommandCenterTarget,
  useCommandCenter,
  useCommandCenterCommands,
} from "../shared";
import { checkAgentProvider, guessTeamForStep, splitRequestIntoSteps } from "./planLogic";
import { useAutoRouting } from "./useAutoRouting";
import { useStartAgentThread } from "./useStartAgentThread";

export interface PlanDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Raw orchestrator text to split into steps. */
  readonly request: string;
  /** Project chosen in the orchestrator bar; null when none. */
  readonly projectId: ProjectId | null;
  /** Machine chosen in the orchestrator bar. */
  readonly target: CommandCenterTarget;
  /** Ready-made steps (with sections and a team) instead of splitting `request`. */
  readonly seed?: CommandCenterPlanSeed;
}

/**
 * Delegation plan: steps, team, machine and section per step, then confirm. Remount it (key)
 * for each new plan so the steps start fresh.
 */
export function PlanDrawer({
  open,
  onOpenChange,
  request,
  projectId,
  target,
  seed,
}: PlanDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>Plan</SheetTitle>
          <SheetDescription>
            <span className="line-clamp-3">{request}</span>
          </SheetDescription>
        </SheetHeader>
        <PlanBody
          request={request}
          initialProjectId={projectId}
          target={target}
          seed={seed}
          onDone={() => onOpenChange(false)}
        />
      </SheetPopup>
    </Sheet>
  );
}

interface PlanStep {
  readonly key: number;
  readonly text: string;
  readonly teamId: CommandCenterTeamId | null;
  /** `auto` selects an eligible project machine. */
  readonly machine: CommandCenterTarget;
  readonly sectionId: CommandCenterSectionId | null;
  /** Own worktree off the project checkout, so steps on one machine never share files. */
  readonly worktree: boolean;
}

const NONE = "__none";
const AUTO = "auto";
let nextStepKey = 0;

/** Worktrees need Git; a project with a known repository starts each step in its own one. */
function defaultWorktree(projectId: ProjectId | null, environmentId: EnvironmentId) {
  if (projectId === null) return true;
  const project = readProject({ environmentId, projectId });
  return project === null || (project.repositoryIdentity ?? null) !== null;
}

function PlanBody({
  request,
  initialProjectId,
  target,
  seed,
  onDone,
}: {
  readonly request: string;
  readonly initialProjectId: ProjectId | null;
  readonly target: CommandCenterTarget;
  readonly seed: CommandCenterPlanSeed | undefined;
  readonly onDone: () => void;
}) {
  const { snapshot, primaryEnvironmentId, projects, canOperate } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const routing = useAutoRouting();
  const environments = routing.environments;
  const states = routing.states;
  const startAgentThread = useStartAgentThread();
  const providersByMachine = routing.providers;
  const teams = snapshot.teams.filter((team) => team.archivedAt === null);
  const agents = snapshot.agentProfiles.filter((agent) => agent.archivedAt === null);

  const [projectId, setProjectId] = useState(initialProjectId);
  const [steps, setSteps] = useState<PlanStep[]>(() => {
    const seeded: CommandCenterPlanSeed["steps"] =
      seed?.steps ?? splitRequestIntoSteps(request).map((text) => ({ text }));
    return seeded.map((step) => {
      const teamId = seed?.teamId ?? guessTeamForStep(step.text, teams, agents);
      const team = teams.find((entry) => entry.id === teamId);
      const agent =
        agents.find(
          (entry) => entry.teamId === teamId && (states.get(entry.id)?.status ?? "idle") === "idle",
        ) ?? null;
      const route = routing.resolve(
        initialProjectId,
        agent,
        target,
        team?.environmentId ?? primaryEnvironmentId,
      );
      return {
        key: nextStepKey++,
        text: step.text,
        teamId,
        machine: target,
        sectionId: step.sectionId ?? null,
        worktree: defaultWorktree(
          initialProjectId,
          "environmentId" in route ? route.environmentId : primaryEnvironmentId,
        ),
      };
    });
  });
  const [running, setRunning] = useState(false);

  const sections = snapshot.sections.filter((section) => section.projectId === projectId);
  const machineLabel = routing.label;
  // Each step takes its own idle agent: one agent works one thread at a time, and starting a
  // second would silently end the first one's assignment.
  const pickAgents = () => {
    const used = new Set<CommandCenterAgentId>();
    return steps.map((step) => {
      const agent =
        agents.find(
          (member) =>
            member.teamId === step.teamId &&
            !used.has(member.id) &&
            (states.get(member.id)?.status ?? "idle") === "idle",
        ) ?? null;
      if (agent) used.add(agent.id);
      return agent;
    });
  };
  const picked = pickAgents();
  const routes = steps.map((step, index) =>
    routing.resolve(
      projectId,
      picked[index] ?? null,
      step.machine,
      teams.find((team) => team.id === step.teamId)?.environmentId ?? primaryEnvironmentId,
    ),
  );
  const providerIssues = steps.map((_step, index) => {
    const agent = picked[index];
    if (!agent) return null;
    const route = routes[index];
    if (!route || "error" in route) return null;
    const environmentId = route.environmentId;
    return checkAgentProvider(
      agent.modelSelection,
      providersByMachine.get(environmentId) ?? null,
      machineLabel(environmentId),
    );
  });
  const problemOf = (step: PlanStep, index: number): string | null => {
    if (!step.text.trim()) return "Describe the step.";
    if (step.teamId === null) return "Pick a team.";
    if (picked[index] === null) {
      return agents.some((agent) => agent.teamId === step.teamId)
        ? "Every agent on this team is busy. Add an agent or pick another team."
        : "This team has no agents.";
    }
    if (projectId === null) return null;
    const route = routes[index];
    if (!route) return "Choose a machine.";
    if ("error" in route) return route.error;
    const issue = providerIssues[index];
    return issue?.level === "error" ? issue.message : null;
  };
  const problems = steps.map(problemOf);
  const ready =
    canOperate &&
    projectId !== null &&
    steps.length > 0 &&
    problems.every((problem) => problem === null);

  const update = (key: number, patch: Partial<PlanStep>) =>
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));

  // Artifacts live with the rest of Command Center on the primary machine; a step running
  // elsewhere gets the ones its text names inlined, since artifact_get cannot reach them there.
  const referencedArtifacts = async (text: string): Promise<StepArtifact[]> => {
    const found = await Promise.all(
      artifactReferenceIds(text).map((id) =>
        commands.getArtifact({ id: CommandCenterArtifactId.make(id), includeContent: true }),
      ),
    );
    return found.flatMap((result) =>
      result._tag === "Success" && result.value.content !== null
        ? [{ title: result.value.artifact.title, content: result.value.content }]
        : [],
    );
  };

  const confirm = async () => {
    if (!ready || running || projectId === null) return;
    setRunning(true);
    let started = 0;
    // Recall reaches handoffs older than the snapshot's memory window.
    const recalled = await commands.recallMemory(projectId);
    const handoffs = latestHandoffs(
      recalled._tag === "Success" ? recalled.value.handoffs : snapshot.memory,
      projectId,
    );
    for (const [index, step] of steps.entries()) {
      const agent = picked[index];
      if (!agent) break;
      const text = step.text.trim();
      const route = routes[index];
      if (!route || "error" in route) break;
      const environmentId = route.environmentId;
      const memoryReachable = environmentId === primaryEnvironmentId;
      const artifacts = memoryReachable ? [] : await referencedArtifacts(text);
      const threadId = await startAgentThread({
        environmentId,
        projectId,
        agent,
        task: text,
        prompt: buildStepPrompt({
          rolePrompt: agent.rolePrompt,
          step: text,
          handoffs,
          memoryReachable,
          artifacts,
        }),
        sectionId: step.sectionId,
        worktree: step.worktree,
      });
      if (threadId === null) break;
      // Drop the started step so a retry cannot start it twice.
      started += 1;
      setSteps((current) => current.filter((entry) => entry.key !== step.key));
    }
    setRunning(false);
    if (started === steps.length) {
      toastManager.add({
        type: "success",
        title: started === 1 ? "Started 1 thread" : `Started ${started} threads`,
      });
      onDone();
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        <ProjectPicker
          projects={projects}
          value={projectId}
          onValueChange={setProjectId}
          allowEmpty={false}
          placeholder="Pick a project"
          ariaLabel="Project"
        />
        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Create a team with at least one agent in the Team tab first.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Steps start together, each in its own thread. With Own worktree on, each also gets its
            own Git worktree, so steps never edit the same files.
          </p>
        )}

        <ol className="space-y-3">
          {steps.map((step, index) => {
            const agent = picked[index];
            return (
              <li key={step.key} className="space-y-2 rounded-xl border bg-card p-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <Input
                      aria-label={`Step ${index + 1}`}
                      value={step.text}
                      onChange={(event) => update(step.key, { text: event.target.value })}
                    />
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Remove step ${index + 1}`}
                    onClick={() =>
                      setSteps((current) => current.filter((entry) => entry.key !== step.key))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    value={step.teamId ?? NONE}
                    onValueChange={(value) =>
                      update(step.key, {
                        teamId: teams.find((team) => team.id === value)?.id ?? null,
                      })
                    }
                  >
                    <SelectTrigger aria-label="Team" size="sm">
                      <SelectValue>
                        {teams.find((team) => team.id === step.teamId)?.name ?? "Pick a team"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {teams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select
                    value={String(step.machine)}
                    onValueChange={(value) =>
                      update(step.key, {
                        machine:
                          environments.find((environment) => environment.environmentId === value)
                            ?.environmentId ?? AUTO,
                      })
                    }
                  >
                    <SelectTrigger aria-label="Machine" size="sm">
                      <SelectValue>
                        {step.machine === AUTO
                          ? `Auto · ${routes[index] && "environmentId" in routes[index] ? machineLabel(routes[index].environmentId) : "unavailable"}`
                          : machineLabel(step.machine)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={AUTO}>Auto (available project machine)</SelectItem>
                      {environments.map((environment) => (
                        <SelectItem
                          key={environment.environmentId}
                          value={environment.environmentId}
                          disabled={!environment.connected}
                        >
                          {environment.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select
                    value={step.sectionId ?? NONE}
                    onValueChange={(value) =>
                      update(step.key, {
                        sectionId: sections.find((section) => section.id === value)?.id ?? null,
                      })
                    }
                  >
                    <SelectTrigger aria-label="Section" size="sm">
                      <SelectValue>
                        {sections.find((section) => section.id === step.sectionId)?.name ??
                          "No section"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={NONE}>No section</SelectItem>
                      {sections.map((section) => (
                        <SelectItem key={section.id} value={section.id}>
                          {section.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {problems[index] ?? (agent ? `Goes to ${agent.name}` : null)}
                  </p>
                  <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    Own worktree
                    <Switch
                      size="sm"
                      checked={step.worktree}
                      onCheckedChange={(worktree) => update(step.key, { worktree })}
                    />
                  </label>
                </div>
                {problems[index] === null && providerIssues[index]?.level === "warning" ? (
                  <p className="text-xs text-warning-foreground">{providerIssues[index].message}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setSteps((current) => [
                ...current,
                {
                  key: nextStepKey++,
                  text: "",
                  teamId: null,
                  machine: target,
                  sectionId: null,
                  worktree: steps.at(-1)?.worktree ?? true,
                },
              ])
            }
          >
            <PlusIcon />
            Add step
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
        {projectId === null ? (
          <span className="me-auto text-xs text-muted-foreground">
            Pick a project to ask the team.
          </span>
        ) : null}
        <Button size="sm" variant="outline" onClick={onDone} disabled={running}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready || running} onClick={() => void confirm()}>
          {steps.length === 1 ? "Start 1 thread" : `Start ${steps.length} threads`}
        </Button>
      </div>
    </>
  );
}
