import type {
  CommandCenterAgentId,
  CommandCenterAgentProfile,
  CommandCenterTeam,
  CommandCenterTeamId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, PencilIcon, PlusIcon, UsersIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import type { CommandCenterAgentState } from "../logic";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import {
  useAgentStates,
  useCommandCenter,
  useCommandCenterAttention,
  useCommandCenterEnvironments,
} from "../shared";
import { unmetDependencies } from "../projects/logic";
import { AgentDrawer } from "./AgentDrawer";
import { AgentRow } from "./AgentRow";
import { ArchivedTeam } from "./ArchivedTeam";
import { AgentDialog, TeamDialog, teamColorClass } from "./TeamForms";
import {
  agentMachineKey,
  resolveDependencyWires,
  resolveHandoffs,
  matchesAgentSearch,
  selectTeamMemberPage,
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

/** Orchestrator, one column per machine with its teams and handoffs; attention lives on Home. */
export function TeamTab() {
  const { snapshot, primaryEnvironmentId, projects, projectId, canOperate } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const states = useAgentStates();
  const attentionCount = useCommandCenterAttention().length;
  const now = useRelativeTimeTick(60_000);
  const [form, setForm] = useState<FormState | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerAgentId, setDrawerAgentId] = useState<CommandCenterAgentId | null>(null);
  const [query, setQuery] = useState("");
  const [machineKey, setMachineKey] = useState("all");
  const [page, setPage] = useState(1);
  const [unassignedPage, setUnassignedPage] = useState(1);
  const stateOf = (agent: CommandCenterAgentProfile) => states.get(agent.id) ?? IDLE_STATE;

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
  const knownMachineIds = useMemo(
    () => new Set<string>(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const isUnassigned = (agent: CommandCenterAgentProfile) =>
    agent.teamId === null || !teams.some((team) => team.id === agent.teamId);
  // Agents without a team whose last machine is gone need the "Unknown machine" filter too.
  const unassignedOnUnknownMachine = agents.some(
    (agent) =>
      isUnassigned(agent) &&
      agentMachineKey(stateOf(agent).assignment, primaryEnvironmentId, knownMachineIds) ===
        "unknown",
  );
  const allColumns = useMemo((): MachineColumn[] => {
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
    const unknown = teams.filter(
      (team) => !knownMachineIds.has(team.environmentId ?? primaryEnvironmentId),
    );
    return unknown.length > 0 || unassignedOnUnknownMachine
      ? [...known, { key: "unknown", label: "Unknown machine", connected: false, teams: unknown }]
      : known;
  }, [environments, knownMachineIds, primaryEnvironmentId, teams, unassignedOnUnknownMachine]);
  const search = query.trim().toLocaleLowerCase();
  const matchesAgent = (agent: CommandCenterAgentProfile) =>
    matchesAgentSearch(agent, stateOf(agent).assignment?.task, search);
  // The project focus filters to agents working on it now; teams without one drop out.
  const onFocus = (agent: CommandCenterAgentProfile) => {
    const assignment = stateOf(agent).assignment;
    return (
      projectId === null ||
      (assignment !== null && assignment.finishedAt === null && assignment.projectId === projectId)
    );
  };
  const membersOf = (team: CommandCenterTeam) =>
    agents.filter((agent) => agent.teamId === team.id && onFocus(agent));
  const filtering = search !== "" || projectId !== null;
  const matchingColumns = allColumns
    .filter((column) => machineKey === "all" || column.key === machineKey)
    .map((column) => ({
      ...column,
      teams: column.teams.filter((team) => {
        const members = membersOf(team);
        if (projectId !== null && members.length === 0) return false;
        return (
          search === "" ||
          `${team.name} ${column.label}`.toLocaleLowerCase().includes(search) ||
          members.some(matchesAgent)
        );
      }),
    }))
    .filter((column) => !filtering || column.teams.length > 0);
  const teamPage = paginateCollection(
    matchingColumns.flatMap((column) => column.teams),
    page,
    6,
  );
  const visibleTeamIds = new Set(teamPage.items.map((team) => team.id));
  const columns = matchingColumns
    .map((column) => ({
      ...column,
      teams: column.teams.filter((team) => visibleTeamIds.has(team.id)),
    }))
    .filter(
      (column) =>
        column.teams.length > 0 || matchingColumns.every((item) => item.teams.length === 0),
    );
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
    (agent) =>
      isUnassigned(agent) &&
      onFocus(agent) &&
      matchesAgent(agent) &&
      (machineKey === "all" ||
        agentMachineKey(stateOf(agent).assignment, primaryEnvironmentId, knownMachineIds) ===
          machineKey),
  );
  const unassignedAgents = paginateCollection(unassigned, unassignedPage, 12);
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
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-2">
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Find a team or agent
            <Input
              size="sm"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
                setUnassignedPage(1);
              }}
              placeholder="Name, role or task"
            />
          </label>
          <div className="min-w-40">
            <Select
              value={machineKey}
              onValueChange={(value) => {
                setMachineKey(value ?? "all");
                setPage(1);
                setUnassignedPage(1);
              }}
            >
              <SelectTrigger size="sm" aria-label="Team machine">
                <SelectValue>
                  {machineKey === "all"
                    ? "All machines"
                    : allColumns.find((column) => column.key === machineKey)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="all">All machines</SelectItem>
                {allColumns.map((column) => (
                  <SelectItem key={column.key} value={column.key}>
                    {column.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
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
      </div>

      {teams.length === 0 && agents.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No teams yet</EmptyTitle>
            <EmptyDescription>
              Create a team, add agents with a role and a model, then give them work with Ask the
              team.
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
            <span className="text-xs text-muted-foreground tabular-nums">
              {counts.working} working · {counts.waiting} waiting on you · {counts.blocked} blocked
              · {counts.limited} limited · {counts.idle} idle
            </span>
          </div>

          {columns.length <= 3 ? (
            <svg
              aria-hidden
              className="h-8 w-full text-border max-xl:hidden"
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
          ) : (
            <div className="h-4" />
          )}

          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-4 max-sm:mt-4">
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
                    const members = membersOf(team);
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
                          <TeamMembers
                            key={`${machineKey}|${search}|${projectId ?? ""}`}
                            members={members}
                            team={team}
                            query={search}
                            taskOf={(agent) => stateOf(agent).assignment?.task}
                            renderAgent={renderAgent}
                          />
                        )}
                      </div>
                    );
                  })
                )}
              </section>
            ))}
          </div>
          <CollectionPager {...teamPage} label="teams" onPageChange={setPage} />
          {teamPage.total === 0 && filtering ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {search !== ""
                ? "No teams match this search. Try another name or machine."
                : "No agent is working on the focused project right now."}
            </p>
          ) : null}

          {teamPage.pageCount === 1 &&
          columns.length <= 3 &&
          arcs.length > 0 &&
          !filtering &&
          machineKey === "all" ? (
            <div
              className="relative max-xl:hidden"
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
                {unassignedAgents.items.map((agent) => renderAgent(agent, false))}
              </ul>
              <CollectionPager
                {...unassignedAgents}
                label="unassigned agents"
                onPageChange={setUnassignedPage}
              />
            </section>
          ) : null}
        </div>
      )}

      {attentionCount > 0 ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {attentionCount} {attentionCount === 1 ? "item needs" : "items need"} you.
          <Button
            size="xs"
            variant="outline"
            render={<Link to="/command" search={{ tab: "home" }} />}
          >
            Open Home
            <ArrowRightIcon />
          </Button>
        </p>
      ) : null}
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

function TeamMembers({
  members,
  team,
  query,
  taskOf,
  renderAgent,
}: {
  members: ReadonlyArray<CommandCenterAgentProfile>;
  team: CommandCenterTeam;
  query: string;
  taskOf: (agent: CommandCenterAgentProfile) => string | null | undefined;
  renderAgent: (agent: CommandCenterAgentProfile, lead: boolean) => ReactNode;
}) {
  const [page, setPage] = useState(1);
  const memberPage = selectTeamMemberPage(members, team.leadAgentId, query, page, taskOf);
  return (
    <div>
      {memberPage.lead ? (
        <ul className="border-b pb-1">{renderAgent(memberPage.lead, true)}</ul>
      ) : null}
      <ul>{memberPage.items.map((agent) => renderAgent(agent, false))}</ul>
      <CollectionPager {...memberPage} label={`members of ${team.name}`} onPageChange={setPage} />
    </div>
  );
}
