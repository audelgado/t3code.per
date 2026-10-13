import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { CommandCenterAgentProfile, CommandCenterTeamId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  PencilIcon,
  SquareIcon,
  UnlinkIcon,
} from "lucide-react";
import { useState } from "react";

import { useDiffPanelStore } from "~/diffPanelStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { deriveCanInterruptRunningThread } from "~/session-logic";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../../ui/sheet";
import type { CommandCenterAgentState } from "../logic";
import {
  useCommandCenter,
  useCommandCenterCommands,
  useCommandCenterEnvironments,
} from "../shared";
import { AgentAvatar, STATUS_LABELS } from "./AgentRow";
import { AgentWorktree } from "./AgentWorktree";

const NO_TEAM = "__none";

/** Replaces one agent profile, keeping every field not in `patch`. */
export function agentProfileInput(
  agent: CommandCenterAgentProfile,
  patch: Partial<Pick<CommandCenterAgentProfile, "teamId">>,
) {
  const { createdAt: _c, updatedAt: _u, archivedAt: _a, ...value } = agent;
  return { entity: "agentProfile" as const, value: { ...value, ...patch } };
}

/** One agent: what it is doing, open thread / stop / release / move, and its step's worktree. */
export function AgentDrawer({
  open,
  agent,
  state,
  now,
  onOpenChange,
  onEdit,
}: {
  readonly open: boolean;
  /** Kept after closing so the drawer keeps its content while it animates out. */
  readonly agent: CommandCenterAgentProfile | null;
  readonly state: CommandCenterAgentState | null;
  readonly now: number;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: (agent: CommandCenterAgentProfile) => void;
}) {
  const { snapshot, projects, canOperate } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const environments = useCommandCenterEnvironments();
  const navigate = useNavigate();
  const interrupt = useOrchestrationCommand(threadEnvironment.interruptTurn, "stop agent");
  const [busy, setBusy] = useState(false);

  const assignment = state?.assignment ?? null;
  const active = assignment !== null && assignment.finishedAt === null;
  const teams = snapshot.teams.filter((team) => !team.archivedAt);
  const machineLabel = (environmentId: string | null) =>
    environments.find((environment) =>
      environmentId === null ? environment.isPrimary : environment.environmentId === environmentId,
    )?.label ?? "Unknown machine";
  const project = projects.find((entry) => entry.id === assignment?.projectId);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    await action();
    setBusy(false);
  };
  const release = () => {
    if (!active) return Promise.resolve();
    const { createdAt: _createdAt, ...value } = assignment;
    return commands.upsert({
      entity: "assignment",
      value: { ...value, finishedAt: new Date().toISOString() },
    });
  };
  const worktreePath = state?.shell?.worktreePath ?? null;
  const openThread = (panel: "diff" | null) => {
    if (!assignment) return;
    const { environmentId, threadId } = assignment;
    if (panel === "diff") {
      const threadRef = scopeThreadRef(environmentId, threadId);
      const latestRun = state?.shell?.latestRun ?? null;
      // In its own worktree everything since the base is the agent's work (the Changes view).
      // In a shared checkout that would include other agents' and the user's edits, so it shows
      // the agent's latest turn instead.
      if (worktreePath === null && latestRun !== null) {
        useDiffPanelStore.getState().selectTurn(threadRef, latestRun.runId);
      } else {
        useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
      }
      useRightPanelStore.getState().open(threadRef, "diff");
    }
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };

  return (
    <Sheet open={open && agent !== null} onOpenChange={onOpenChange}>
      <SheetPopup side="right">
        {agent ? (
          <>
            <SheetHeader>
              <div className="flex items-center gap-3">
                <AgentAvatar agent={agent} status={state?.status ?? "idle"} />
                <div className="min-w-0">
                  <SheetTitle>{agent.name}</SheetTitle>
                  <SheetDescription>
                    {[agent.role, agent.modelSelection.model].filter(Boolean).join(" · ")}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6">
              <section className="space-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">Status: </span>
                  {STATUS_LABELS[state?.status ?? "idle"]}
                  {state?.since ? ` for ${formatElapsedDurationLabel(state.since, now)}` : ""}
                </p>
                {active ? (
                  <>
                    <p className="text-muted-foreground">{assignment.task}</p>
                    <p className="text-muted-foreground">
                      {project?.title ?? "Unknown project"} on{" "}
                      {machineLabel(assignment.environmentId)}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">No current task.</p>
                )}
              </section>

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={assignment === null}
                  onClick={() => openThread(null)}
                >
                  <ExternalLinkIcon />
                  Open thread
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={assignment === null}
                  onClick={() => openThread("diff")}
                >
                  <FileDiffIcon />
                  View changes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !active ||
                    busy ||
                    // Same rule as the thread view: any interruptible run, waiting ones included.
                    !deriveCanInterruptRunningThread(true, state?.shell?.runtime ?? null)
                  }
                  onClick={() =>
                    assignment &&
                    void run(() =>
                      interrupt({
                        environmentId: assignment.environmentId,
                        input: { threadId: assignment.threadId },
                      }),
                    )
                  }
                >
                  <SquareIcon />
                  Stop
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!active || busy || !canOperate}
                  onClick={() => void run(release)}
                >
                  <UnlinkIcon />
                  Release
                </Button>
              </div>

              {state?.shell && worktreePath !== null ? (
                <AgentWorktree
                  shell={state.shell}
                  worktreePath={worktreePath}
                  onDiscarded={release}
                />
              ) : null}

              <div className="space-y-1.5">
                <Label>Team and machine</Label>
                <Select
                  value={agent.teamId ?? NO_TEAM}
                  disabled={!canOperate || busy}
                  onValueChange={(value) => {
                    const teamId: CommandCenterTeamId | null =
                      teams.find((team) => team.id === value)?.id ?? null;
                    if (teamId !== agent.teamId) {
                      void run(() => commands.upsert(agentProfileInput(agent, { teamId })));
                    }
                  }}
                >
                  <SelectTrigger aria-label="Move to team">
                    <SelectValue>
                      {(() => {
                        const team = teams.find((entry) => entry.id === agent.teamId);
                        return team
                          ? `${team.name} · ${machineLabel(team.environmentId)}`
                          : "No team";
                      })()}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_TEAM}>No team</SelectItem>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name} · {machineLabel(team.environmentId)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  New work runs on the machine of the agent's team.
                </p>
              </div>

              <div className="mt-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canOperate}
                  onClick={() => onEdit(agent)}
                >
                  <PencilIcon />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  disabled={!canOperate || busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await commands.remove({
                        entity: "agentProfile",
                        id: agent.id,
                      });
                      if (result._tag === "Success") onOpenChange(false);
                    })
                  }
                >
                  <ArchiveIcon />
                  Archive
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
