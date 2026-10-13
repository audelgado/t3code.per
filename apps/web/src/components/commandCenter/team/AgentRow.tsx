import type { CommandCenterAgentProfile } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import type { CommandCenterAgentState, CommandCenterAgentStatus } from "../logic";

export const STATUS_LABELS: Record<CommandCenterAgentStatus, string> = {
  working: "Working",
  waiting: "Waiting on you",
  blocked: "Blocked",
  limited: "Usage limited",
  idle: "Idle",
};

const STATUS_RING: Record<CommandCenterAgentStatus, string> = {
  working: "ring-success",
  waiting: "ring-warning",
  blocked: "ring-destructive",
  limited: "ring-info",
  idle: "ring-border",
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

export function AgentAvatar({
  agent,
  status,
}: {
  readonly agent: CommandCenterAgentProfile;
  readonly status: CommandCenterAgentStatus;
}) {
  return (
    <span
      role="img"
      aria-label={`${agent.name}: ${STATUS_LABELS[status]}`}
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium ring-2 ring-offset-2 ring-offset-card",
        STATUS_RING[status],
      )}
    >
      {agent.avatar || initials(agent.name)}
    </span>
  );
}

/** Avatar, name, role, model, current task, project and elapsed time. Click opens the drawer. */
export function AgentRow({
  agent,
  state,
  projectTitle,
  dimmed,
  isLead,
  now,
  onOpen,
}: {
  readonly agent: CommandCenterAgentProfile;
  readonly state: CommandCenterAgentState;
  readonly projectTitle: string | null;
  readonly dimmed: boolean;
  readonly isLead: boolean;
  readonly now: number;
  readonly onOpen: () => void;
}) {
  const task =
    state.assignment && state.assignment.finishedAt === null ? state.assignment.task : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg p-2 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
        dimmed && "opacity-40",
      )}
    >
      <AgentAvatar agent={agent} status={state.status} />
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{agent.name}</span>
          {isLead ? <span className="text-xs text-muted-foreground">lead</span> : null}
          {state.since ? (
            <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
              {formatElapsedDurationLabel(state.since, now)}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {[agent.role, agent.modelSelection.model].filter(Boolean).join(" · ")}
        </span>
        <span className="block truncate text-xs">
          {task ? (
            <>
              {task}
              {projectTitle ? (
                <span className="text-muted-foreground"> · {projectTitle}</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted-foreground">{STATUS_LABELS[state.status]}</span>
          )}
        </span>
      </span>
    </button>
  );
}
