import { buildStepPrompt, latestHandoffs } from "@t3tools/client-runtime/command-center-delegation";
import type {
  CommandCenterAgentId,
  CommandCenterSectionId,
  CommandCenterTeamId,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { readProject, useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import {
  type CommandCenterPlanSeed,
  type CommandCenterTarget,
  useAgentStates,
  useCommandCenter,
  useCommandCenterCommands,
  useCommandCenterEnvironments,
} from "../shared";
import {
  checkAgentProvider,
  guessTeamForStep,
  resolveStepMachine,
  splitRequestIntoSteps,
} from "./planLogic";
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
  /** `auto` follows the team's machine. */
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
  const environments = useCommandCenterEnvironments();
  const states = useAgentStates();
  const allProjects = useProjects();
  const startAgentThread = useStartAgentThread();
  // Provider lists every known machine already streams in its server config; null until loaded.
  const providersAtom = useMemo(
    () =>
      Atom.make(
        (get) =>
          new Map(
            environments.map(
              ({ environmentId }) =>
                [environmentId, get(serverEnvironment.providersValueAtom(environmentId))] as const,
            ),
          ),
      ),
    [environments],
  );
  const providersByMachine = useAtomValue(providersAtom);
  const teams = snapshot.teams.filter((team) => team.archivedAt === null);
  const agents = snapshot.agentProfiles.filter((agent) => agent.archivedAt === null);

  const [projectId, setProjectId] = useState(initialProjectId);
  const [steps, setSteps] = useState<PlanStep[]>(() => {
    const worktree = defaultWorktree(
      initialProjectId,
      target === AUTO ? primaryEnvironmentId : target,
    );
    const seeded: CommandCenterPlanSeed["steps"] =
      seed?.steps ?? splitRequestIntoSteps(request).map((text) => ({ text }));
    return seeded.map((step) => ({
      key: nextStepKey++,
      text: step.text,
      teamId: seed?.teamId ?? guessTeamForStep(step.text, teams, agents),
      machine: target,
      sectionId: step.sectionId ?? null,
      worktree,
    }));
  });
  const [running, setRunning] = useState(false);

  const sections = snapshot.sections.filter((section) => section.projectId === projectId);
  const machineOf = (step: PlanStep): EnvironmentId =>
    resolveStepMachine(
      step.machine,
      teams.find((team) => team.id === step.teamId),
      primaryEnvironmentId,
    );
  const machineLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "Unknown machine";

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
  const providerIssues = steps.map((step, index) => {
    const agent = picked[index];
    if (!agent) return null;
    const environmentId = machineOf(step);
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
    const environmentId = machineOf(step);
    if (!environments.some((env) => env.environmentId === environmentId && env.connected)) {
      return `${machineLabel(environmentId)} is offline.`;
    }
    const issue = providerIssues[index];
    if (issue?.level === "error") return issue.message;
    if (
      !allProjects.some(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )
    ) {
      return `This project is not on ${machineLabel(environmentId)}.`;
    }
    return null;
  };
  const problems = steps.map(problemOf);
  const ready =
    canOperate &&
    projectId !== null &&
    steps.length > 0 &&
    problems.every((problem) => problem === null);

  const update = (key: number, patch: Partial<PlanStep>) =>
    setSteps((current) => current.map((step) => (step.key === key ? { ...step, ...patch } : step)));

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
      const environmentId = machineOf(step);
      const threadId = await startAgentThread({
        environmentId,
        projectId,
        agent,
        task: text,
        prompt: buildStepPrompt({
          rolePrompt: agent.rolePrompt,
          step: text,
          handoffs,
          memoryReachable: environmentId === primaryEnvironmentId,
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
        title: started === 1 ? "Delegated 1 step" : `Delegated ${started} steps`,
      });
      onDone();
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4">
        <Select
          value={projectId ?? NONE}
          onValueChange={(value) =>
            setProjectId(projects.find((project) => project.id === value)?.id ?? null)
          }
        >
          <SelectTrigger aria-label="Project">
            <SelectValue>
              {projects.find((project) => project.id === projectId)?.title ?? "Pick a project"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
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
                          ? `Auto · ${machineLabel(machineOf(step))}`
                          : machineLabel(step.machine)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={AUTO}>Auto (team's machine)</SelectItem>
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
          <span className="me-auto text-xs text-muted-foreground">Pick a project to delegate.</span>
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
