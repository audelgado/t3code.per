import {
  COMMAND_CENTER_ONBOARDING_LEAD_ID,
  COMMAND_CENTER_ONBOARDING_TEAM_ID,
  type CommandCenterAgentId,
  type CommandCenterAgentProfile,
  type CommandCenterSection,
  type CommandCenterTeam,
  type CommandCenterTeamId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, UsersIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import type { CommandCenterAgentState } from "../logic";
import {
  useAgentStates,
  useCommandCenter,
  useCommandCenterCommands,
  useCommandCenterEnvironments,
} from "../shared";
import { unmetDependencies } from "../projects/logic";
import { AgentDrawer } from "./AgentDrawer";
import { AgentRow } from "./AgentRow";
import { ArchivedTeam } from "./ArchivedTeam";
import { PendingRequestAnswer } from "./PendingRequestAnswer";
import { AgentDialog, TeamDialog, teamColorClass } from "./TeamForms";
import {
  commandCenterAlerts,
  daysUntil,
  resolveDependencyWires,
  resolveHandoffs,
} from "./teamLogic";

type FormState =
  | { readonly kind: "team"; readonly team: CommandCenterTeam | null }
  | {
      readonly kind: "agent";
      readonly agent: CommandCenterAgentProfile | null;
      readonly teamId: CommandCenterTeamId | null;
    };

interface MachineColumn {
  readonly key: string;
  readonly label: string;
  readonly connected: boolean;
  readonly teams: ReadonlyArray<CommandCenterTeam>;
}

const IDLE_STATE: CommandCenterAgentState = {
  status: "idle",
  assignment: null,
  shell: null,
  since: null,
  waitingThreadId: null,
};
/** Prefix the onboarding Lead gives interview questions it saves as todos (see onboarding.ts). */
const QUESTION_PREFIX = "Question: ";
const MAX_HANDOFF_ARCS = 4;
const MAX_DEPENDENCY_ARCS = 4;

interface Arc {
  readonly key: string;
  readonly from: CommandCenterTeamId;
  readonly to: CommandCenterTeamId;
  readonly label: string;
  /** Dependencies draw denser dashes than handoffs. */
  readonly kind: "handoff" | "dependency";
}

/** Orchestrator, one column per machine with its teams, handoffs and what's missing. */
export function TeamTab() {
  const { snapshot, primaryEnvironmentId, projects, projectId, canOperate } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const states = useAgentStates();
  const now = useRelativeTimeTick(60_000);
  const [form, setForm] = useState<FormState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerAgentId, setDrawerAgentId] = useState<CommandCenterAgentId | null>(null);

  const teams = useMemo(
    () =>
      snapshot.teams
        .filter((team) => team.archivedAt === null)
        .toSorted((left, right) => left.sortKey - right.sortKey),
    [snapshot.teams],
  );
  const agents = useMemo(
    () =>
      snapshot.agentProfiles
        .filter((agent) => agent.archivedAt === null)
        .toSorted((left, right) => left.sortKey - right.sortKey),
    [snapshot.agentProfiles],
  );
  const columns = useMemo((): MachineColumn[] => {
    const byMachine = new Map<string, CommandCenterTeam[]>();
    for (const team of teams) {
      const key = team.environmentId ?? primaryEnvironmentId;
      byMachine.set(key, [...(byMachine.get(key) ?? []), team]);
    }
    const known: MachineColumn[] = environments.map((environment) => ({
      key: environment.environmentId,
      label: environment.label,
      connected: environment.connected,
      teams: byMachine.get(environment.environmentId) ?? [],
    }));
    const knownIds = new Set<string>(environments.map((environment) => environment.environmentId));
    const unknown = teams.filter(
      (team) => !knownIds.has(team.environmentId ?? primaryEnvironmentId),
    );
    return unknown.length > 0
      ? [...known, { key: "unknown", label: "Unknown machine", connected: false, teams: unknown }]
      : known;
  }, [environments, primaryEnvironmentId, teams]);
  const columnIndexByTeam = new Map(
    columns.flatMap((column, index) => column.teams.map((team) => [team.id, index] as const)),
  );
  const handoffs = useMemo(
    () => resolveHandoffs(snapshot.memory, snapshot.assignments, agents, teams, 8),
    [agents, snapshot.assignments, snapshot.memory, teams],
  );
  const unmet = useMemo(() => unmetDependencies(snapshot.sections), [snapshot.sections]);
  const dependencyWires = useMemo(
    () => resolveDependencyWires(unmet, snapshot.sections, snapshot.assignments, agents),
    [agents, snapshot.assignments, snapshot.sections, unmet],
  );

  const projectTitle = (id: string | undefined) =>
    projects.find((project) => project.id === id)?.title ?? null;
  const stateOf = (agent: CommandCenterAgentProfile) => states.get(agent.id) ?? IDLE_STATE;
  const isDimmed = (agent: CommandCenterAgentProfile) => {
    const assignment = stateOf(agent).assignment;
    return (
      projectId !== null &&
      (assignment === null || assignment.finishedAt !== null || assignment.projectId !== projectId)
    );
  };
  const teamName = (id: CommandCenterTeamId | null) =>
    teams.find((team) => team.id === id)?.name ?? "Unknown team";
  const counts = agents.reduce(
    (total, agent) => {
      total[stateOf(agent).status] += 1;
      return total;
    },
    { working: 0, waiting: 0, blocked: 0, limited: 0, idle: 0 },
  );
  const unassigned = agents.filter(
    (agent) => agent.teamId === null || !teams.some((team) => team.id === agent.teamId),
  );
  const drawerAgent = snapshot.agentProfiles.find((agent) => agent.id === drawerAgentId) ?? null;

  const openAgent = (agent: CommandCenterAgentProfile) => {
    setDrawerAgentId(agent.id);
    setDrawerOpen(true);
  };
  const renderAgent = (agent: CommandCenterAgentProfile, lead: boolean) => {
    const state = stateOf(agent);
    return (
      <li key={agent.id}>
        <AgentRow
          agent={agent}
          state={state}
          projectTitle={projectTitle(state.assignment?.projectId)}
          dimmed={isDimmed(agent)}
          isLead={lead}
          now={now}
          onOpen={() => openAgent(agent)}
        />
      </li>
    );
  };

  const arcs: Arc[] = [
    ...handoffs
      .flatMap(({ entry, from, to }) =>
        from !== null && to !== null
          ? [
              {
                key: entry.id,
                from,
                to,
                label: `${teamName(from)} → ${teamName(to)}`,
                kind: "handoff" as const,
              },
            ]
          : [],
      )
      .slice(0, MAX_HANDOFF_ARCS),
    ...dependencyWires
      .flatMap(({ section, dependency, from, to }) =>
        from !== null && to !== null
          ? [
              {
                key: `${section.id}:${dependency.id}`,
                from,
                to,
                label: `${section.name} waiting on ${dependency.name}`,
                kind: "dependency" as const,
              },
            ]
          : [],
      )
      .slice(0, MAX_DEPENDENCY_ARCS),
  ];
  const columnX = (index: number) => ((index + 0.5) / columns.length) * 100;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate}
          onClick={() => setForm({ kind: "team", team: null })}
        >
          <PlusIcon />
          New team
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canOperate}
          onClick={() => setForm({ kind: "agent", agent: null, teamId: teams[0]?.id ?? null })}
        >
          <PlusIcon />
          New agent
        </Button>
      </div>

      {teams.length === 0 && agents.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No teams yet</EmptyTitle>
            <EmptyDescription>
              Create a team, add agents with a role and a model, then delegate work from the bar
              above.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              size="sm"
              disabled={!canOperate}
              onClick={() => setForm({ kind: "team", team: null })}
            >
              <UsersIcon />
              Create a team
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col">
          <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-1 rounded-xl border bg-card p-3 text-center">
            <span className="text-sm font-medium">Orchestrator</span>
            <span className="text-xs text-muted-foreground">
              {counts.working} working · {counts.waiting} waiting on you · {counts.blocked} blocked
              · {counts.idle} idle
            </span>
          </div>

          <svg
            aria-hidden
            className="h-8 w-full text-border max-sm:hidden"
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
          >
            {columns.map((column, index) => (
              <path
                key={column.key}
                d={`M 50 0 C 50 16, ${columnX(index)} 16, ${columnX(index)} 32`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                className={cn(column.teams.length === 0 && "opacity-40")}
              />
            ))}
          </svg>

          <div
            className="grid gap-4 max-sm:mt-4 sm:[grid-template-columns:repeat(var(--cc-columns),minmax(0,1fr))]"
            style={{ "--cc-columns": columns.length } as CSSProperties}
          >
            {columns.map((column) => (
              <section key={column.key} className="flex min-w-0 flex-col gap-3">
                <header className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span
                    className={cn(
                      "size-2 rounded-full",
                      column.connected ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  <span className="truncate font-medium text-foreground">{column.label}</span>
                  {column.connected ? null : <span>offline</span>}
                </header>
                {column.teams.length === 0 ? (
                  <p className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                    No teams on this machine.
                  </p>
                ) : (
                  column.teams.map((team) => {
                    const members = agents.filter((agent) => agent.teamId === team.id);
                    return (
                      <div key={team.id} className="rounded-xl border bg-card p-2">
                        <div className="flex items-center gap-2 px-2 py-1">
                          <span
                            className={cn("size-2.5 rounded-full", teamColorClass(team.color))}
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {team.name}
                          </span>
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`Add agent to ${team.name}`}
                            disabled={!canOperate}
                            onClick={() => setForm({ kind: "agent", agent: null, teamId: team.id })}
                          >
                            <PlusIcon />
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost-muted"
                            aria-label={`Edit ${team.name}`}
                            disabled={!canOperate}
                            onClick={() => setForm({ kind: "team", team })}
                          >
                            <PencilIcon />
                          </Button>
                        </div>
                        {members.length === 0 ? (
                          <p className="px-2 py-1 text-xs text-muted-foreground">No agents.</p>
                        ) : (
                          <ul>
                            {members.map((agent) =>
                              renderAgent(agent, agent.id === team.leadAgentId),
                            )}
                          </ul>
                        )}
                      </div>
                    );
                  })
                )}
              </section>
            ))}
          </div>

          {arcs.length > 0 ? (
            <div
              className="relative max-sm:hidden"
              style={{ height: `${24 + arcs.length * 12}px` }}
              aria-hidden
            >
              <svg
                className="absolute inset-0 size-full"
                viewBox={`0 0 100 ${24 + arcs.length * 12}`}
                preserveAspectRatio="none"
              >
                {arcs.map((arc, index) => {
                  const from = columnX(columnIndexByTeam.get(arc.from) ?? 0);
                  const to = columnX(columnIndexByTeam.get(arc.to) ?? 0);
                  const [x1, x2] = from === to ? [from - 4, to + 4] : [from, to];
                  const depth = 20 + index * 12;
                  return (
                    <path
                      key={arc.key}
                      d={`M ${x1} 0 C ${x1} ${depth}, ${x2} ${depth}, ${x2} 0`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={1}
                      strokeDasharray={arc.kind === "handoff" ? "4 3" : "2 2"}
                      vectorEffect="non-scaling-stroke"
                      className={
                        arc.kind === "handoff" ? "text-muted-foreground" : "text-warning-foreground"
                      }
                    />
                  );
                })}
              </svg>
              {arcs.map((arc, index) => {
                const from = columnX(columnIndexByTeam.get(arc.from) ?? 0);
                const to = columnX(columnIndexByTeam.get(arc.to) ?? 0);
                return (
                  <span
                    key={arc.key}
                    className={cn(
                      "absolute max-w-48 -translate-x-1/2 truncate rounded bg-background px-1 text-2xs",
                      arc.kind === "handoff" ? "text-muted-foreground" : "text-warning-foreground",
                    )}
                    style={{ left: `${(from + to) / 2}%`, top: `${4 + index * 12}px` }}
                  >
                    {arc.label}
                  </span>
                );
              })}
            </div>
          ) : null}

          {unassigned.length > 0 ? (
            <section className="mt-4 rounded-xl border bg-card p-2">
              <h3 className="px-2 py-1 text-sm font-medium">No team</h3>
              <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                {unassigned.map((agent) => renderAgent(agent, false))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <WhatsMissing
          agents={agents}
          stateOf={stateOf}
          teamName={teamName}
          unmet={unmet}
          hostEnvironmentIds={
            new Set([
              ...columns.flatMap((column) => (column.teams.length > 0 ? [column.key] : [])),
              ...snapshot.assignments.flatMap((assignment) =>
                assignment.finishedAt === null ? [assignment.environmentId] : [],
              ),
            ])
          }
          now={now}
        />
        {handoffs.length > 0 ? (
          <section className="rounded-xl border bg-card p-4">
            <h3 className="mb-2 text-sm font-medium">Handoffs</h3>
            <ul className="space-y-2 text-sm">
              {handoffs.map(({ entry, from, to }) => (
                <li key={entry.id} className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">
                    {from ? teamName(from) : "Someone"}
                    {to ? ` → ${teamName(to)}` : ""} · {formatRelativeTimeLabel(entry.createdAt)}
                  </p>
                  <p className="line-clamp-2">{entry.text}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <ArchivedTeam />

      <AgentDrawer
        open={drawerOpen}
        agent={drawerAgent}
        state={drawerAgent ? stateOf(drawerAgent) : null}
        now={now}
        onOpenChange={setDrawerOpen}
        onEdit={(agent) => {
          setDrawerOpen(false);
          setForm({ kind: "agent", agent, teamId: agent.teamId });
        }}
      />
      {form?.kind === "team" ? <TeamDialog team={form.team} onClose={() => setForm(null)} /> : null}
      {form?.kind === "agent" ? (
        <AgentDialog agent={form.agent} teamId={form.teamId} onClose={() => setForm(null)} />
      ) : null}
    </div>
  );
}

function sectionInput(section: CommandCenterSection, patch: Partial<CommandCenterSection>) {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = { ...section, ...patch };
  return { entity: "section" as const, value };
}

/**
 * Alerts, questions for the user, blocked sections, unmet dependencies, deliveries due within a
 * week, and idle agents.
 */
function WhatsMissing({
  agents,
  stateOf,
  teamName,
  unmet,
  hostEnvironmentIds,
  now,
}: {
  readonly agents: ReadonlyArray<CommandCenterAgentProfile>;
  readonly stateOf: (agent: CommandCenterAgentProfile) => CommandCenterAgentState;
  readonly teamName: (id: CommandCenterTeamId | null) => string;
  readonly unmet: ReadonlyMap<CommandCenterSection["id"], ReadonlyArray<CommandCenterSection>>;
  readonly hostEnvironmentIds: ReadonlySet<string>;
  readonly now: number;
}) {
  const { snapshot, projects, projectId, canOperate, openPlan } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const commands = useCommandCenterCommands();
  const navigate = useNavigate();
  // One inline answer at a time, so only one thread's detail is subscribed.
  const [answering, setAnswering] = useState<CommandCenterAgentId | null>(null);
  const projectTitle = (id: string) =>
    projects.find((project) => project.id === id)?.title ?? "Unknown project";
  const dim = (id: string | null | undefined) => projectId !== null && id !== projectId;
  const openThread = (environmentId: EnvironmentId, threadId: string) =>
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });

  const waiting = agents.filter((agent) => stateOf(agent).status === "waiting");
  const blocked = snapshot.sections.filter((section) => section.status === "blocked");
  const due = snapshot.sections
    .filter((section) => section.status !== "done" && section.dueDate !== null)
    .map((section) => ({ section, days: daysUntil(section.dueDate!, now) }))
    .filter(({ days }) => days <= 7)
    .toSorted((left, right) => left.days - right.days);
  // Onboarding helpers only run under their Lead, so only the Lead can be given work.
  const idle = agents.filter(
    (agent) =>
      stateOf(agent).status === "idle" &&
      (agent.teamId !== COMMAND_CENTER_ONBOARDING_TEAM_ID ||
        agent.id === COMMAND_CENTER_ONBOARDING_LEAD_ID),
  );
  // Interview questions the onboarding Lead could not ask live; it closes them once answered.
  const questions = snapshot.memory.filter(
    (entry) => entry.kind === "todo" && !entry.done && entry.text.startsWith(QUESTION_PREFIX),
  );
  const alerts = commandCenterAlerts({
    environments,
    hostEnvironmentIds,
    agents: agents.map((agent) => ({ agentId: agent.id, state: stateOf(agent) })),
    sections: snapshot.sections,
    now,
  });
  const atRisk = new Set(
    alerts.flatMap((alert) => (alert.kind === "delivery" ? [alert.section.id] : [])),
  );
  const waitingOn = snapshot.sections.flatMap((section) => {
    const dependencies = unmet.get(section.id);
    return dependencies ? [{ section, dependencies }] : [];
  });
  const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));
  const empty =
    alerts.length +
      waiting.length +
      blocked.length +
      waitingOn.length +
      due.length +
      questions.length +
      idle.length ===
    0;

  return (
    <section className="rounded-xl border bg-card p-4">
      <h3 className="mb-2 text-sm font-medium">What's missing</h3>
      {empty ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
      ) : (
        <ul className="divide-y text-sm">
          {alerts.map((alert) => {
            if (alert.kind === "offline") {
              return (
                <MissingRow
                  key={`offline:${alert.environmentId}`}
                  dimmed={false}
                  tone="alert"
                  text={`${alert.label} is disconnected`}
                  detail="Its teams and agents cannot be seen or reached"
                  action={null}
                />
              );
            }
            if (alert.kind === "stuck") {
              const agent = agentById.get(alert.agentId);
              const assignment = agent ? stateOf(agent).assignment : null;
              return (
                <MissingRow
                  key={`stuck:${alert.agentId}`}
                  dimmed={dim(assignment?.projectId)}
                  tone="alert"
                  text={`${agent?.name ?? "Agent"} has shown no activity for ${alert.minutes} min`}
                  detail={assignment?.task ?? null}
                  action={
                    assignment ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => openThread(assignment.environmentId, assignment.threadId)}
                      >
                        Open
                      </Button>
                    ) : null
                  }
                />
              );
            }
            return (
              <MissingRow
                key={`risk:${alert.section.id}`}
                dimmed={dim(alert.section.projectId)}
                tone="alert"
                text={`${alert.section.name} is due ${
                  alert.days === 0
                    ? "today"
                    : alert.days === 1
                      ? "tomorrow"
                      : `in ${alert.days} days`
                } at ${alert.percent}%`}
                detail={projectTitle(alert.section.projectId)}
                action={null}
              />
            );
          })}
          {waiting.map((agent) => {
            const { assignment, waitingThreadId } = stateOf(agent);
            // The question may sit in a child thread the agent delegated to.
            const threadId = waitingThreadId ?? assignment?.threadId;
            return (
              <MissingRow
                key={`waiting:${agent.id}`}
                dimmed={dim(assignment?.projectId)}
                text={`${agent.name} is waiting on you`}
                detail={assignment?.task ?? null}
                action={
                  assignment ? (
                    <>
                      <Button
                        size="xs"
                        variant={answering === agent.id ? "secondary" : "outline"}
                        aria-expanded={answering === agent.id}
                        onClick={() =>
                          setAnswering((current) => (current === agent.id ? null : agent.id))
                        }
                      >
                        Answer
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          openThread(assignment.environmentId, threadId ?? assignment.threadId)
                        }
                      >
                        Open thread
                      </Button>
                    </>
                  ) : null
                }
              >
                {assignment && answering === agent.id ? (
                  <PendingRequestAnswer
                    environmentId={assignment.environmentId}
                    threadId={threadId ?? assignment.threadId}
                  />
                ) : null}
              </MissingRow>
            );
          })}
          {blocked.map((section) => (
            <MissingRow
              key={`blocked:${section.id}`}
              dimmed={dim(section.projectId)}
              text={`${section.name} is blocked`}
              detail={[projectTitle(section.projectId), section.blocker]
                .filter(Boolean)
                .join(" · ")}
              action={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOperate}
                  onClick={() =>
                    void commands.upsert(
                      sectionInput(section, { status: "in_progress", blocker: null }),
                    )
                  }
                >
                  Resolved
                </Button>
              }
            />
          ))}
          {waitingOn.map(({ section, dependencies }) => (
            <MissingRow
              key={`depends:${section.id}`}
              dimmed={dim(section.projectId)}
              text={`${section.name} is waiting on ${dependencies
                .map((dependency) => dependency.name)
                .join(", ")}`}
              detail={[
                projectTitle(section.projectId),
                ...dependencies.flatMap((dependency) =>
                  dependency.projectId === section.projectId
                    ? []
                    : [`${dependency.name} in ${projectTitle(dependency.projectId)}`],
                ),
              ].join(" · ")}
              action={null}
            />
          ))}
          {due
            .filter(({ section }) => !atRisk.has(section.id))
            .map(({ section, days }) => (
              <MissingRow
                key={`due:${section.id}`}
                dimmed={dim(section.projectId)}
                text={`${section.name} ${
                  days < 0
                    ? `is ${-days} day${days === -1 ? "" : "s"} overdue`
                    : days === 0
                      ? "is due today"
                      : `is due in ${days} day${days === 1 ? "" : "s"}`
                }`}
                detail={`${projectTitle(section.projectId)} · ${section.tasksDone}/${section.tasksTotal} tasks`}
                action={null}
              />
            ))}
          {questions.map((entry) => {
            const assignment = entry.threadId
              ? snapshot.assignments.find((candidate) => candidate.threadId === entry.threadId)
              : undefined;
            return (
              <MissingRow
                key={`question:${entry.id}`}
                dimmed={dim(entry.projectId)}
                text={entry.text.slice(QUESTION_PREFIX.length)}
                detail={
                  entry.projectId ? `Question · ${projectTitle(entry.projectId)}` : "Question"
                }
                action={
                  assignment ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openThread(assignment.environmentId, assignment.threadId)}
                    >
                      Open thread
                    </Button>
                  ) : null
                }
              />
            );
          })}
          {idle.map((agent) => (
            <MissingRow
              key={`idle:${agent.id}`}
              dimmed={false}
              text={`${agent.name} is idle`}
              detail={agent.teamId ? teamName(agent.teamId) : null}
              action={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={agent.teamId === null}
                  onClick={() =>
                    openPlan({ projectId, steps: [{ text: "" }], teamId: agent.teamId })
                  }
                >
                  Give work
                </Button>
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MissingRow({
  text,
  detail,
  dimmed,
  action,
  tone = "default",
  children,
}: {
  readonly text: string;
  readonly detail: string | null;
  readonly dimmed: boolean;
  readonly action: ReactNode;
  readonly tone?: "default" | "alert";
  /** Shown under the row, such as an inline answer. */
  readonly children?: ReactNode;
}) {
  return (
    <li className={cn("flex flex-col gap-2 py-2", dimmed && !children && "opacity-40")}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate", tone === "alert" && "text-destructive-foreground")}>
            {text}
          </span>
          {detail ? (
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          ) : null}
        </span>
        {action}
      </div>
      {children}
    </li>
  );
}
