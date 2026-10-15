import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthDiagnosticsReadScope,
  type CommandCenterAgentProfile,
  type EnvironmentId,
  type HostDiskVolume,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { formatBytes } from "~/lib/formatBytes";
import { useResourceTelemetry } from "~/lib/resourceTelemetryState";
import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import type { CommandCenterAgentState, CommandCenterAgentStatus } from "../logic";
import { useAgentStates, useCommandCenter } from "../shared";
import {
  classifyLink,
  formatRoundTrip,
  type InfraLinkType,
  pushSample,
  sparklinePoints,
} from "./logic";
import { ProjectPreviewButton } from "../projects/ProjectPreview";
import { useDocumentVisible } from "./useDocumentVisible";

/** Host resources and round trip refresh this often while the window is visible. */
const HOST_REFRESH_MS = 15_000;
const SPARKLINE_SAMPLES = 40;
/** Processes doing agent work, as opposed to T3's own server and desktop shell. */
const WORK_PROCESS_CATEGORIES = new Set(["server-child", "provider-root", "terminal-root"]);

interface InfraMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: EnvironmentPresentation["connection"]["phase"];
  readonly connected: boolean;
  readonly link: InfraLinkType;
  readonly isPrimary: boolean;
}

interface InfraProject {
  readonly id: ProjectId;
  readonly title: string;
  /** Machines that have this project checked out, with that machine's copy. */
  readonly hosts: ReadonlyMap<EnvironmentId, EnvironmentProject>;
  /** Machines with an open assignment on it. */
  readonly builders: ReadonlySet<EnvironmentId>;
}

interface InfraAgent {
  readonly profile: CommandCenterAgentProfile;
  readonly state: CommandCenterAgentState;
}

const statusDot: Record<CommandCenterAgentStatus, string> = {
  working: "bg-success",
  waiting: "bg-warning",
  blocked: "bg-destructive",
  limited: "bg-info",
  idle: "bg-muted-foreground/40",
};

/** Infra tab: topology, then one card per machine with live resource use. */
export function InfraTab() {
  const { snapshot, projectId } = useCommandCenter();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const allProjects = useProjects();
  const agentStates = useAgentStates();
  const [query, setQuery] = useState("");
  const [machineKey, setMachineKey] = useState("all");
  const [page, setPage] = useState(1);
  const [topologyPage, setTopologyPage] = useState(1);

  const machines = useMemo(
    (): ReadonlyArray<InfraMachine> =>
      environments
        .map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          phase: environment.connection.phase,
          connected: environment.connection.phase === "connected",
          link: classifyLink(environment.entry),
          isPrimary: environment.environmentId === primaryEnvironmentId,
        }))
        .toSorted((left, right) => Number(right.isPrimary) - Number(left.isPrimary)),
    [environments, primaryEnvironmentId],
  );

  const projects = useMemo((): ReadonlyArray<InfraProject> => {
    const byId = new Map<
      ProjectId,
      {
        title: string;
        hosts: Map<EnvironmentId, EnvironmentProject>;
        builders: Set<EnvironmentId>;
      }
    >();
    for (const project of allProjects) {
      if (project.isScratch) continue;
      const entry = byId.get(project.id) ?? {
        title: project.title,
        hosts: new Map(),
        builders: new Set(),
      };
      entry.hosts.set(project.environmentId, project);
      byId.set(project.id, entry);
    }
    for (const assignment of snapshot.assignments) {
      if (assignment.finishedAt === null)
        byId.get(assignment.projectId)?.builders.add(assignment.environmentId);
    }
    return [...byId].map(([id, entry]) => ({ id, ...entry }));
  }, [allProjects, snapshot.assignments]);

  const agentsByMachine = useMemo(() => {
    const result = new Map<EnvironmentId, InfraAgent[]>();
    for (const profile of snapshot.agentProfiles) {
      const state = agentStates.get(profile.id);
      const assignment = state?.assignment;
      if (!state || !assignment || assignment.finishedAt !== null) continue;
      const list = result.get(assignment.environmentId) ?? [];
      list.push({ profile, state });
      result.set(assignment.environmentId, list);
    }
    return result;
  }, [agentStates, snapshot.agentProfiles]);
  // The project focus filters to that project and the machines that host or build it.
  const focused = projectId === null ? null : projects.find((project) => project.id === projectId);
  const machinePage = paginateCollection(
    machines.filter(
      (machine) =>
        (machineKey === "all" || machine.environmentId === machineKey) &&
        (projectId === null ||
          focused?.hosts.has(machine.environmentId) === true ||
          focused?.builders.has(machine.environmentId) === true),
    ),
    page,
    6,
  );
  const visibleProjects = projects.filter(
    (project) =>
      (projectId === null || project.id === projectId) &&
      project.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const topologyProjects = paginateCollection(
    visibleProjects.filter((project) =>
      machinePage.items.some(
        (machine) =>
          project.hosts.has(machine.environmentId) || project.builders.has(machine.environmentId),
      ),
    ),
    topologyPage,
    8,
  );

  if (machines.length === 0) {
    return <p className="text-sm text-muted-foreground">No environments are connected yet.</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
        <div className="min-w-48 flex-1">
          <Input
            size="sm"
            aria-label="Search infrastructure projects"
            placeholder="Find a project on your machines"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setTopologyPage(1);
            }}
          />
        </div>
        <div className="min-w-40">
          <Select
            value={machineKey}
            onValueChange={(value) => {
              setMachineKey(value ?? "all");
              setPage(1);
              setTopologyPage(1);
            }}
          >
            <SelectTrigger size="sm" aria-label="Infrastructure machine">
              <SelectValue>
                {machineKey === "all"
                  ? "All machines"
                  : machines.find((machine) => machine.environmentId === machineKey)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All machines</SelectItem>
              {machines.map((machine) => (
                <SelectItem key={machine.environmentId} value={machine.environmentId}>
                  {machine.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {machines.filter((machine) => machine.connected).length} connected / {machines.length}{" "}
          machines
        </span>
      </div>
      <Collapsible defaultOpen={projects.length <= 6 && machines.length <= 3}>
        <CollapsibleTrigger render={<Button size="sm" variant="outline" />}>
          Connection map · {topologyProjects.total} projects on this page of machines
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="mt-3 max-h-96 overflow-auto rounded-xl">
            <Topology machines={machinePage.items} projects={topologyProjects.items} />
          </div>
          <CollectionPager
            {...topologyProjects}
            label="map projects"
            onPageChange={setTopologyPage}
          />
        </CollapsiblePanel>
      </Collapsible>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {machinePage.items.map((machine) => (
          <MachineCard
            key={machine.environmentId}
            machine={machine}
            agents={(agentsByMachine.get(machine.environmentId) ?? []).filter(
              (agent) => projectId === null || agent.state.assignment?.projectId === projectId,
            )}
            projects={visibleProjects.filter(
              (project) =>
                project.hosts.has(machine.environmentId) ||
                project.builders.has(machine.environmentId),
            )}
          />
        ))}
      </div>
      {machinePage.total === 0 && projectId !== null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No machine hosts or builds the focused project.
        </p>
      ) : null}
      <CollectionPager {...machinePage} label="machines" onPageChange={setPage} />
    </div>
  );
}

const ROW = 52;
const NODE_W = 150;
const NODE_H = 36;
const CLIENT_X = 16;
const MACHINE_X = 250;
const PROJECT_X = 520;
const VIEW_W = PROJECT_X + NODE_W + 16;

function linkTone(machine: InfraMachine) {
  if (machine.connected) return "text-success";
  if (machine.phase === "connecting" || machine.phase === "reconnecting") return "text-warning";
  return "text-muted-foreground";
}

/** Static SVG map: this client, the machines it reaches, and the projects on each machine. */
function Topology({
  machines,
  projects,
}: {
  readonly machines: ReadonlyArray<InfraMachine>;
  readonly projects: ReadonlyArray<InfraProject>;
}) {
  const rows = Math.max(machines.length, projects.length, 1);
  const height = rows * ROW + 8;
  const rowY = (index: number, count: number) =>
    (height - count * ROW) / 2 + index * ROW + (ROW - NODE_H) / 2;
  const machineY = new Map(
    machines.map((machine, index) => [machine.environmentId, rowY(index, machines.length)]),
  );
  const clientY = (height - NODE_H) / 2;

  return (
    <section className="rounded-xl border bg-card p-3">
      <h2 className="mb-2 text-sm font-medium">Topology</h2>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        className="min-w-160 w-full"
        style={{ height: Math.max(160, height) }}
        role="img"
        aria-label="Machines and the projects that live on them"
      >
        {machines.map((machine) => {
          const y = (machineY.get(machine.environmentId) ?? 0) + NODE_H / 2;
          const x1 = CLIENT_X + NODE_W;
          const midX = (x1 + MACHINE_X) / 2;
          const midY = (clientY + NODE_H / 2 + y) / 2;
          return (
            <g key={machine.environmentId} className={linkTone(machine)}>
              <line
                x1={x1}
                y1={clientY + NODE_H / 2}
                x2={MACHINE_X}
                y2={y}
                className="stroke-current"
                strokeWidth={1.5}
                strokeDasharray={machine.connected ? undefined : "4 4"}
              />
              <LinkLabel machine={machine} x={midX} y={midY - 4} />
            </g>
          );
        })}
        {projects.map((project, index) => {
          const y = rowY(index, projects.length) + NODE_H / 2;
          return (
            <g key={project.id}>
              {machines.map((machine) => {
                const hosts = project.hosts.has(machine.environmentId);
                if (!hosts && !project.builders.has(machine.environmentId)) return null;
                return (
                  <line
                    key={machine.environmentId}
                    x1={MACHINE_X + NODE_W}
                    y1={(machineY.get(machine.environmentId) ?? 0) + NODE_H / 2}
                    x2={PROJECT_X}
                    y2={y}
                    className={cn("stroke-current", hosts ? "text-border" : "text-info")}
                    strokeWidth={1.25}
                    strokeDasharray={hosts ? undefined : "3 3"}
                  />
                );
              })}
              <Node x={PROJECT_X} y={y - NODE_H / 2} title={project.title} subtitle="Project" />
            </g>
          );
        })}
        <Node x={CLIENT_X} y={clientY} title="This client" subtitle="You" />
        {machines.map((machine) => (
          <Node
            key={machine.environmentId}
            x={MACHINE_X}
            y={machineY.get(machine.environmentId) ?? 0}
            title={machine.label}
            subtitle={machine.isPrimary ? `Primary · ${machine.phase}` : machine.phase}
            dotClassName={linkTone(machine)}
          />
        ))}
      </svg>
      <p className="mt-1 text-xs text-muted-foreground">
        Solid project lines: checked out there. Dashed: an agent is building it there.
      </p>
    </section>
  );
}

/** Round trip of one no-op RPC; shared with the machine card, which drives the refresh. */
function useRoundTrip(machine: InfraMachine) {
  const { environmentId, connected } = machine;
  return useEnvironmentQuery(
    connected ? serverEnvironment.connectionRoundTrip({ environmentId, input: {} }) : null,
  );
}

function LinkLabel({
  machine,
  x,
  y,
}: {
  readonly machine: InfraMachine;
  readonly x: number;
  readonly y: number;
}) {
  const roundTrip = useRoundTrip(machine).data;
  return (
    <text x={x} y={y} textAnchor="middle" className="fill-muted-foreground text-3xs">
      {roundTrip === null ? machine.link : `${machine.link} · ${formatRoundTrip(roundTrip)}`}
    </text>
  );
}

function Node({
  x,
  y,
  title,
  subtitle,
  dotClassName,
}: {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly subtitle: string;
  readonly dotClassName?: string;
}) {
  const label = title.length > 20 ? `${title.slice(0, 19)}…` : title;
  return (
    <g>
      <title>{title}</title>
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={8}
        className="fill-background stroke-border"
      />
      {dotClassName ? (
        <circle
          cx={x + 12}
          cy={y + NODE_H / 2}
          r={4}
          className={cn("fill-current", dotClassName)}
        />
      ) : null}
      <text
        x={x + (dotClassName ? 22 : 10)}
        y={y + 15}
        className="fill-foreground text-2xs font-medium"
      >
        {label}
      </text>
      <text x={x + (dotClassName ? 22 : 10)} y={y + 28} className="fill-muted-foreground text-3xs">
        {subtitle}
      </text>
    </g>
  );
}

function MachineCard({
  machine,
  agents,
  projects,
}: {
  readonly machine: InfraMachine;
  readonly agents: ReadonlyArray<InfraAgent>;
  readonly projects: ReadonlyArray<InfraProject>;
}) {
  const { environmentId, connected } = machine;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const visible = useDocumentVisible();
  const host = useEnvironmentQuery(
    connected ? serverEnvironment.hostResources({ environmentId, input: {} }) : null,
  );
  // The subscription drops as soon as this card unmounts or the window hides (idleTtlMs 0), so
  // telemetry only runs while the Infra tab is on screen. Top processes come from it too.
  const telemetry = useResourceTelemetry(connected && visible ? environmentId : null);
  const roundTrip = useRoundTrip(machine);

  const refreshHost = host.refresh;
  const refreshRoundTrip = roundTrip.refresh;
  useEffect(() => {
    if (!connected) return;
    // A backgrounded window skips the poll; the next visible tick catches up.
    const whenVisible = (refresh: () => void) => () => {
      if (document.visibilityState === "visible") refresh();
    };
    const hostTimer = setInterval(
      whenVisible(() => {
        refreshHost();
        refreshRoundTrip();
      }),
      HOST_REFRESH_MS,
    );
    return () => clearInterval(hostTimer);
  }, [connected, refreshHost, refreshRoundTrip]);

  // Ring buffer of T3 CPU, appended once per telemetry sample (render-time state update, no effect).
  const [cpuHistory, setCpuHistory] = useState<{ readAt: number; samples: ReadonlyArray<number> }>({
    readAt: 0,
    samples: [],
  });
  const sample = telemetry.data;
  const sampleAt = sample ? DateTime.toEpochMillis(sample.readAt) : 0;
  if (sample && sampleAt !== cpuHistory.readAt) {
    setCpuHistory({
      readAt: sampleAt,
      samples: pushSample(
        cpuHistory.samples,
        sample.groups.allT3.currentCpuPercent,
        SPARKLINE_SAMPLES,
      ),
    });
  }

  const resources = host.data;
  const cpuPercent = resources?.cpuUtilization == null ? null : resources.cpuUtilization * 100;
  const usedMemory = resources ? resources.totalMemoryBytes - resources.availableMemoryBytes : 0;
  const topProcesses = useMemo(
    () =>
      (sample?.processes ?? [])
        .filter((process) => WORK_PROCESS_CATEGORIES.has(process.category))
        .toSorted((left, right) => right.cpuPercent - left.cpuPercent)
        .slice(0, 5),
    [sample],
  );
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-3">
      <header className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{machine.label}</h3>
        <Badge variant="outline" size="sm">
          {roundTrip.data === null
            ? machine.link
            : `${machine.link} · ${formatRoundTrip(roundTrip.data)}`}
        </Badge>
        <Badge
          variant={connected ? "success" : machine.phase === "error" ? "error" : "warning"}
          size="sm"
        >
          {machine.phase}
        </Badge>
      </header>

      {connected ? (
        <>
          <div className="grid gap-2">
            <Meter
              label="Machine CPU"
              percent={cpuPercent}
              detail={
                cpuPercent === null
                  ? "Sampling…"
                  : `${Math.round(cpuPercent)}% of ${resources?.cpuCount ?? 0} cores`
              }
            />
            <Meter
              label="Machine RAM"
              percent={
                resources && resources.totalMemoryBytes > 0
                  ? (usedMemory / resources.totalMemoryBytes) * 100
                  : null
              }
              detail={
                resources
                  ? `${formatBytes(usedMemory)} of ${formatBytes(resources.totalMemoryBytes)}`
                  : "Sampling…"
              }
            />
            {resources?.disks === undefined || resources.disks.length === 0 ? (
              <Meter
                label="Disk"
                percent={null}
                detail={
                  !resources
                    ? "Sampling…"
                    : resources.disks === undefined
                      ? "Not reported by this server"
                      : "Disk usage unavailable"
                }
              />
            ) : (
              resources.disks.map((volume) => <DiskMeter key={volume.path} volume={volume} />)
            )}
          </div>

          {canReadDiagnostics ? (
            <div>
              <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                <span>T3 processes CPU</span>
                <span className="tabular-nums">
                  {sample
                    ? `${Math.round(sample.groups.allT3.currentCpuPercent)}% · ${formatBytes(sample.groups.allT3.currentRssBytes)}`
                    : "Waiting for samples"}
                </span>
              </div>
              <svg
                viewBox="0 0 200 32"
                preserveAspectRatio="none"
                className="h-8 w-full text-info"
                aria-hidden
              >
                <polyline
                  points={sparklinePoints(cpuHistory.samples, 200, 30)}
                  fill="none"
                  className="stroke-current"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              This connection cannot read diagnostics.
            </p>
          )}

          <CardList title="Agents here" empty="No agents working here.">
            {agents.map(({ profile, state }) => (
              <li key={profile.id} className="flex items-center gap-2 text-xs">
                <span className={cn("size-2 shrink-0 rounded-full", statusDot[state.status])} />
                <span className="font-medium">{profile.name}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {state.assignment?.task}
                </span>
              </li>
            ))}
          </CardList>

          {canReadDiagnostics ? (
            <CardList
              title="Top agent processes"
              empty={sample ? "No agent processes running." : "Waiting for samples"}
            >
              {topProcesses.map((process) => (
                <li
                  key={process.identity.pid}
                  className="flex items-center gap-2 text-xs tabular-nums"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{process.command}</span>
                  <span className="w-12 text-right">{process.cpuPercent.toFixed(1)}%</span>
                  <span className="w-16 text-right text-muted-foreground">
                    {formatBytes(process.residentBytes)}
                  </span>
                </li>
              ))}
            </CardList>
          ) : null}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Not connected, so no live resource data.</p>
          <Button render={<Link to="/settings/connections" />} size="xs" variant="outline">
            Reconnect
          </Button>
        </div>
      )}

      <CardList title="Projects" empty="No projects on this machine.">
        {projects.map((project) => {
          const checkout = connected ? project.hosts.get(environmentId) : undefined;
          return (
            <li key={project.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{project.title}</span>
              {project.builders.has(environmentId) ? (
                <Badge variant="info" size="sm">
                  building
                </Badge>
              ) : null}
              {checkout ? (
                <ProjectPreviewButton project={checkout} environmentId={environmentId} compact />
              ) : null}
            </li>
          );
        })}
      </CardList>
    </section>
  );
}

function DiskMeter({ volume }: { readonly volume: HostDiskVolume }) {
  const projects = `${volume.projectCount} project${volume.projectCount === 1 ? "" : "s"}`;
  return (
    <Meter
      label={volume.home ? "Disk" : `Disk · ${projects}`}
      percent={((volume.totalBytes - volume.availableBytes) / volume.totalBytes) * 100}
      detail={`${formatBytes(volume.availableBytes)} free of ${formatBytes(volume.totalBytes)}`}
    />
  );
}

function Meter({
  label,
  percent,
  detail,
}: {
  readonly label: string;
  readonly percent: number | null;
  readonly detail: string;
}) {
  const value = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground tabular-nums">{detail}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            value >= 90 ? "bg-destructive" : value >= 70 ? "bg-warning" : "bg-success",
          )}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function CardList({
  title,
  empty,
  children,
}: {
  readonly title: string;
  readonly empty: string;
  readonly children: ReadonlyArray<ReactNode>;
}) {
  const [page, setPage] = useState(1);
  const rows = paginateCollection(children, page, 8);
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      {children.length > 0 ? (
        <ul className="flex flex-col gap-2">{rows.items}</ul>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
      {rows.pageCount > 1 ? (
        <CollectionPager {...rows} label={title.toLocaleLowerCase()} onPageChange={setPage} />
      ) : null}
    </div>
  );
}
