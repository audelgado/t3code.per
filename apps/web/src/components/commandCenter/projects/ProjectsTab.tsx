import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AuthSettingsWriteScope,
  COMMAND_CENTER_MAX_PROJECTS,
  type CommandCenterAgentId,
  type CommandCenterSection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronDownIcon,
  DownloadIcon,
  FolderInputIcon,
  PinIcon,
  PlusIcon,
  TagsIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import {
  usePrimarySettings,
  usePrimarySettingsAvailable,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { moveProject, PROJECT_SORT_KEY } from "../projectOrder";
import { cn } from "~/lib/utils";
import { useAllEnvironmentProjectSnapshotsReady, useThreadShells } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { toastManager } from "../../ui/toast";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import type { CommandCenterAgentState } from "../logic";
import { useStartOnboarding } from "../plan/useStartOnboarding";
import { useAgentStates, useCommandCenter, useCommandCenterEnvironments } from "../shared";
import {
  addDays,
  countByStatus,
  dueLabel,
  localDate,
  nextDelivery,
  projectHealth,
  projectProgress,
  SECTION_STATUS_LABEL,
  sortSections,
  STRIP_DAYS,
  stripMarkers,
  unmetDependencies,
} from "./logic";
import { ProjectCard } from "./ProjectCard";
import {
  filterProjectDirectory,
  latestThreadByProject,
  type ProjectDirectoryPageSize,
  type ProjectDirectorySort,
  type ProjectDirectoryStatus,
  type ProjectEntry,
  projectEntryKey,
  pruneProjectEntries,
  updateProjectEntries,
} from "./projectDirectory";
import { ProjectGroupsDialog } from "./ProjectGroupsDialog";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Open work" },
  { value: "attention", label: "Needs attention" },
  { value: "untracked", label: "No sections" },
  { value: "complete", label: "Completed" },
] as const;
const PROJECT_SORT_SCHEMA = Schema.Literals([
  "activity",
  "name",
  "attention",
  "delivery",
  "manual",
]);
const SORT_OPTIONS = [
  { value: "activity", label: "Recent activity" },
  { value: "name", label: "Name" },
  { value: "attention", label: "Attention first" },
  { value: "delivery", label: "Next delivery" },
  { value: "manual", label: "Manual" },
] as const;
const MARKER_COLOR = {
  todo: "bg-muted-foreground",
  in_progress: "bg-info",
  review: "bg-warning",
  blocked: "bg-destructive",
  done: "bg-success",
} as const;
const HEALTH_LABEL = { green: "On track", amber: "At risk", red: "Needs attention" } as const;
const HEALTH_BADGE = { green: "success", amber: "warning", red: "error" } as const;
const axisFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const formatDay = (day: string) => axisFormat.format(Date.parse(`${day}T00:00:00Z`));

function DirectorySelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((item) => item.value === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-xl font-semibold tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{hint}</span>
    </div>
  );
}

function ProjectSummary({
  project,
  sections,
  today,
  activeAgents,
  waitingSections,
  environmentLabel,
  selected,
  disabled,
  onOpen,
  pinned,
  groupName,
  checked,
  onCheckedChange,
  reorder,
}: {
  reorder: { up: () => void; down: () => void; first: boolean; last: boolean } | undefined;
  project: EnvironmentProject;
  sections: readonly CommandCenterSection[];
  today: string;
  activeAgents: number;
  waitingSections: number;
  environmentLabel: string;
  selected: boolean;
  disabled: boolean;
  onOpen: () => void;
  pinned: boolean;
  groupName: string | null;
  /** Multi-select state; undefined hides the checkbox (no permission to edit groups). */
  checked: boolean | undefined;
  onCheckedChange: (checked: boolean) => void;
}) {
  const health = projectHealth({ sections, today, activeAgents, waitingSections });
  const progress = projectProgress(sections);
  const delivery = nextDelivery(sections, today);
  return (
    <li className="flex min-w-0">
      {checked === undefined ? null : (
        <div className="flex shrink-0 ps-3 pt-3.5">
          <Checkbox
            checked={checked}
            aria-label={`Select ${project.title}`}
            onCheckedChange={(next) => onCheckedChange(next === true)}
          />
        </div>
      )}
      {reorder ? (
        <div className="flex shrink-0 flex-col gap-1 p-2">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move ${project.title} up`}
            disabled={reorder.first}
            onClick={reorder.up}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Move ${project.title} down`}
            disabled={reorder.last}
            onClick={reorder.down}
          >
            <ArrowDownIcon />
          </Button>
        </div>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              id={`cc-project-summary-${project.id}`}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              aria-controls="command-center-project-detail"
              onClick={onOpen}
              className={cn(
                "flex w-full min-w-0 flex-col gap-2 border-s-2 p-3 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                selected ? "border-s-primary bg-muted/40" : "border-s-transparent",
              )}
            />
          }
        >
          <div className="flex min-w-0 items-center gap-2">
            {pinned ? (
              <PinIcon aria-label="Pinned" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.title}</span>
            <Badge variant={sections.length === 0 ? "outline" : HEALTH_BADGE[health.level]}>
              {sections.length === 0 ? "No sections" : HEALTH_LABEL[health.level]}
            </Badge>
          </div>
          <span className="truncate text-xs text-muted-foreground">
            {environmentLabel} · {project.workspaceRoot}
          </span>
          {/* The group badge sits on this wrapping line so it never squeezes the title on a phone. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {groupName ? <Badge variant="outline">{groupName}</Badge> : null}
            <span className="tabular-nums">
              {progress.percent}% · {progress.delivered}/{sections.length} sections
            </span>
            <span>
              {activeAgents} active agent{activeAgents === 1 ? "" : "s"}
            </span>
            <span>
              {delivery
                ? `Due ${formatDay(delivery.section.dueDate ?? today)}`
                : "No upcoming delivery"}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipPopup>
          <p>
            {project.title} · {environmentLabel}
          </p>
          <p>{project.workspaceRoot}</p>
          {health.reasons.slice(0, 3).map((reason, index) => (
            // oxlint-disable-next-line no-array-index-key -- two sections can share a reason
            <p key={index}>{reason}</p>
          ))}
          {health.reasons.length > 3 ? <p>+{health.reasons.length - 3} more</p> : null}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

function DeliveryStrip({
  projects,
  sectionsByProject,
  today,
  onOpen,
  lockedProjectId,
}: {
  projects: readonly EnvironmentProject[];
  sectionsByProject: ReadonlyMap<ProjectId, readonly CommandCenterSection[]>;
  today: string;
  onOpen: (project: EnvironmentProject) => void;
  lockedProjectId: ProjectId | null;
}) {
  return (
    <Collapsible>
      <section className="rounded-xl border bg-card p-4">
        <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
          <ChevronDownIcon />
          Deliveries · next 5 weeks
        </CollapsibleTrigger>
        <CollapsiblePanel animate={false}>
          <p className="py-2 text-xs text-muted-foreground">
            Projects on the current directory page. Open a delivery to see its project details.
          </p>
          <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1">
            <div />
            <div className="relative h-4 text-2xs text-muted-foreground">
              {[0, 7, 14, 21, 28, 35].map((offset) => (
                <span
                  key={offset}
                  className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
                  style={{ left: `${(offset / STRIP_DAYS) * 100}%` }}
                >
                  {offset === 0 ? "Today" : formatDay(addDays(today, offset))}
                </span>
              ))}
            </div>
            {projects.map((project) => {
              // One marker per day bounds the calendar even for projects with many sections.
              const days = new Map<number, ReturnType<typeof stripMarkers>>();
              for (const marker of stripMarkers(sectionsByProject.get(project.id) ?? [], today)) {
                const group = days.get(marker.days);
                if (group) group.push(marker);
                else days.set(marker.days, [marker]);
              }
              return (
                <div key={project.id} className="contents">
                  <span className="truncate text-xs leading-6">{project.title}</span>
                  <div className="relative h-6 border-s-2 border-primary/60">
                    <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                    {[...days].map(([day, markers]) => {
                      const marker =
                        markers.find((item) => item.section.status === "blocked") ?? markers[0]!;
                      return (
                        <Tooltip key={day}>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                disabled={
                                  lockedProjectId !== null && lockedProjectId !== project.id
                                }
                                className={cn(
                                  "absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card focus-visible:outline-2 focus-visible:outline-ring",
                                  MARKER_COLOR[marker.section.status],
                                )}
                                style={{ left: `${marker.left}%` }}
                                aria-label={`${project.title}: ${markers.length} deliveries due ${marker.section.dueDate}`}
                                onClick={() => onOpen(project)}
                              />
                            }
                          />
                          <TooltipPopup>
                            {markers.slice(0, 3).map(({ section }) => (
                              <p key={section.id}>
                                {section.name} · {section.dueDate} ·{" "}
                                {SECTION_STATUS_LABEL[section.status]}
                              </p>
                            ))}
                            {markers.length > 3 ? <p>+{markers.length - 3} more</p> : null}
                          </TooltipPopup>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

const ALL_GROUPS = "__all__";

/**
 * A bounded directory and one stable detail panel; browsing never unmounts an editor. The open
 * detail is the page's project focus (`?project=`), so a reload or a shared link reopens it and
 * the other tabs follow it. The directory itself is never narrowed by the focus.
 */
export function ProjectsTab() {
  const {
    snapshot,
    projects,
    projectId: detailProjectId,
    setProjectFocus: onDetailChange,
  } = useCommandCenter();
  const environments = useCommandCenterEnvironments();
  const agentStates = useAgentStates();
  const startOnboarding = useStartOnboarding();
  const today = localDate(useRelativeTimeTick(60_000));
  const [query, setQuery] = useState("");
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [status, setStatus] = useState<ProjectDirectoryStatus>("all");
  const [sort, setSort] = useLocalStorage<ProjectDirectorySort, ProjectDirectorySort>(
    PROJECT_SORT_KEY,
    "activity",
    PROJECT_SORT_SCHEMA,
  );
  const [reordering, setReordering] = useState(false);
  const projectOrder = usePrimarySettings((settings) => settings.commandCenter.projectOrder);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<ProjectDirectoryPageSize>(10);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [editingSectionId, setEditingSectionId] = useState<
    CommandCenterSection["id"] | "new" | null
  >(null);

  const sectionsByProject = useMemo(() => {
    const grouped = new Map<ProjectId, CommandCenterSection[]>();
    for (const section of sortSections(snapshot.sections)) {
      const list = grouped.get(section.projectId);
      if (list) list.push(section);
      else grouped.set(section.projectId, [section]);
    }
    return grouped;
  }, [snapshot.sections]);
  const unmet = useMemo(() => unmetDependencies(snapshot.sections), [snapshot.sections]);
  // Pins, groups and links live in the primary settings, like the rest of Customize.
  const entryList = usePrimarySettings((settings) => settings.commandCenter.projects);
  const groups = usePrimarySettings((settings) => settings.commandCenter.projectGroups);
  const updateSettings = useUpdatePrimarySettings();
  const primary = usePrimaryEnvironment();
  const settingsAvailable = usePrimarySettingsAvailable();
  const canEdit =
    useEnvironmentScope(primary?.environmentId ?? null, AuthSettingsWriteScope) &&
    settingsAvailable;
  const entries = useMemo(
    () => new Map(entryList.map((entry) => [entry.key, entry] as const)),
    [entryList],
  );
  const groupNames = useMemo(
    () => new Map(groups.map((group) => [group.id, group.name] as const)),
    [groups],
  );
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) {
      const id = entries.get(projectEntryKey(project))?.groupId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [entries, projects]);
  if (groupId !== null && !groupNames.has(groupId)) setGroupId(null);
  const shells = useThreadShells();
  const latestThreads = useMemo(() => latestThreadByProject(shells), [shells]);
  const projectsKnown = useAllEnvironmentProjectSnapshotsReady();
  const changeEntries = (keys: Iterable<string>, patch: Partial<Omit<ProjectEntry, "key">>) => {
    // Entries of removed projects are invisible, so drop them before they block the cap.
    const live = new Set(
      projectsKnown
        ? environments.flatMap((environment) =>
            environment.connected ? [environment.environmentId as string] : [],
          )
        : [],
    );
    const next = updateProjectEntries(pruneProjectEntries(entryList, projects, live), keys, patch);
    if (next.length > COMMAND_CENTER_MAX_PROJECTS) {
      toastManager.add({
        type: "error",
        title: "Too many customized projects",
        description: `Up to ${COMMAND_CENTER_MAX_PROJECTS} projects can be pinned, grouped or linked. Unpin or ungroup one first.`,
      });
      return false;
    }
    updateSettings({ commandCenter: { projects: next } });
    return true;
  };
  const agentNames = useMemo(
    () => new Map(snapshot.agentProfiles.map((agent) => [agent.id, agent.name] as const)),
    [snapshot.agentProfiles],
  );
  const agentsByProject = useMemo(() => {
    const grouped = new Map<
      ProjectId,
      (CommandCenterAgentState & { agentId: CommandCenterAgentId })[]
    >();
    for (const [agentId, state] of agentStates) {
      if (state.status === "idle" || state.assignment === null) continue;
      const id = state.assignment.projectId;
      const list = grouped.get(id);
      if (list) list.push({ ...state, agentId });
      else grouped.set(id, [{ ...state, agentId }]);
    }
    return grouped;
  }, [agentStates]);
  const activeAgentCounts = useMemo(
    () => new Map([...agentsByProject].map(([id, agents]) => [id, agents.length] as const)),
    [agentsByProject],
  );
  const filteredProjects = useMemo(
    () =>
      filterProjectDirectory({
        projects,
        sectionsByProject,
        query,
        environmentId,
        status,
        sort,
        today,
        activeAgentCounts,
        entries,
        groupId,
        activity: latestThreads,
        order: projectOrder,
      }),
    [
      projects,
      sectionsByProject,
      query,
      environmentId,
      status,
      sort,
      today,
      activeAgentCounts,
      entries,
      groupId,
      latestThreads,
      projectOrder,
    ],
  );
  // Materialize the complete visual order before moving; filters must not drop hidden projects.
  const manualProjects = useMemo(
    () =>
      filterProjectDirectory({
        projects,
        sectionsByProject,
        query: "",
        environmentId: null,
        status: "all",
        sort: "manual",
        today,
        entries,
        order: projectOrder,
      }),
    [projects, sectionsByProject, today, entries, projectOrder],
  );
  const manualKeys = manualProjects.map(projectEntryKey);
  const directory = useMemo(
    () => paginateCollection(filteredProjects, page, pageSize),
    [filteredProjects, page, pageSize],
  );
  if (page !== directory.page) setPage(directory.page);
  const scoped = useMemo(
    () => filteredProjects.flatMap((project) => sectionsByProject.get(project.id) ?? []),
    [filteredProjects, sectionsByProject],
  );
  const { counts, next } = useMemo(
    () => ({ counts: countByStatus(scoped), next: nextDelivery(scoped, today) }),
    [scoped, today],
  );
  const nextProject = useMemo(
    () => (next ? projects.find((project) => project.id === next.section.projectId) : null),
    [next, projects],
  );
  const environmentNames = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const machineOptions = useMemo(
    () => [
      { value: "all", label: "All machines" },
      ...[...new Set(projects.map((project) => project.environmentId))].map((id) => ({
        value: id as string,
        label: environmentNames.get(id) ?? id,
      })),
    ],
    [projects, environmentNames],
  );
  const detailProject = projects.find((project) => project.id === detailProjectId);
  const detailSections = detailProject ? (sectionsByProject.get(detailProject.id) ?? []) : [];
  const detailEditing =
    detailProject !== undefined &&
    (editingSectionId === "new" ||
      detailSections.some((section) => section.id === editingSectionId));
  if (editingSectionId !== null && !detailEditing) setEditingSectionId(null);
  const lockedProjectId = detailEditing && detailProject ? detailProject.id : null;
  const openDetails = (project: EnvironmentProject) => {
    if (lockedProjectId !== null && lockedProjectId !== project.id) return;
    if (project.id !== detailProjectId) {
      setEditingSectionId(null);
      onDetailChange(project.id);
    }
    const panel = document.getElementById("command-center-project-detail");
    panel?.scrollIntoView({ block: "start" });
    panel?.focus({ preventScroll: true });
  };
  // A filter that narrows the directory to one project opens it when no details are open, once
  // per narrowing, so closing the detail afterwards sticks.
  const filtered = query !== "" || environmentId !== null || status !== "all" || groupId !== null;
  const soleMatchId = filtered && filteredProjects.length === 1 ? filteredProjects[0]!.id : null;
  const openSoleMatch = useEffectEvent((id: ProjectId) => {
    if (detailProject === undefined && lockedProjectId === null) onDetailChange(id);
  });
  useEffect(() => {
    if (soleMatchId !== null) openSoleMatch(soleMatchId);
  }, [soleMatchId]);
  const clearFilters = () => {
    setQuery("");
    setEnvironmentId(null);
    setStatus("all");
    setGroupId(null);
    setPage(1);
  };
  const selectedKeys = projects.map(projectEntryKey).filter((key) => selection.has(key));
  const moveSelection = (nextGroupId: string | null) => {
    if (changeEntries(selectedKeys, { groupId: nextGroupId })) setSelection(new Set());
  };
  const pageKeys = directory.items.map(projectEntryKey);
  const pageSelected = pageKeys.length > 0 && pageKeys.every((key) => selection.has(key));
  const launchButtons = (
    <>
      <Button
        size="xs"
        variant="outline"
        onClick={() => openCommandPalette({ open: "add-project" })}
      >
        <PlusIcon />
        Add project
      </Button>
      <Button size="xs" variant="ghost" render={<Link to="/welcome" />}>
        <DownloadIcon />
        Import from Claude Code / Codex
      </Button>
    </>
  );

  if (projects.length === 0)
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-6">
        <p className="text-sm text-muted-foreground">
          No projects yet. Add a folder or repository, or import your Claude Code and Codex
          projects.
        </p>
        <div className="flex flex-wrap gap-2">{launchButtons}</div>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div
        className="grid grid-cols-2 gap-3 lg:grid-cols-4"
        aria-label="Summary of filtered projects"
      >
        <Kpi
          label="In progress"
          value={counts.in_progress}
          hint={`${directory.total} matching projects`}
        />
        <Kpi label="To review" value={counts.review} hint="waiting for your OK" />
        <Kpi label="Blocked" value={counts.blocked} hint={`${counts.todo} not started`} />
        <Kpi
          label="Next delivery"
          value={
            next ? `${formatDay(next.section.dueDate ?? today)} · ${dueLabel(next.days)}` : "None"
          }
          hint={
            next ? `${nextProject?.title ?? "Project"} · ${next.section.name}` : "nothing scheduled"
          }
        />
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section
          className="min-w-0 overflow-hidden rounded-xl border bg-card"
          aria-label="Project directory"
        >
          <div className="space-y-3 border-b p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="command-center-project-directory-heading"
                tabIndex={-1}
                className="me-auto text-sm font-medium"
              >
                Projects
              </h2>
              {launchButtons}
            </div>
            {groups.length > 0 || canEdit ? (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 overflow-x-auto">
                  <ToggleGroup
                    aria-label="Project group"
                    variant="segmented"
                    value={[groupId ?? ALL_GROUPS]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next === undefined) return;
                      setGroupId(next === ALL_GROUPS ? null : next);
                      setPage(1);
                    }}
                  >
                    <Toggle value={ALL_GROUPS}>All · {projects.length}</Toggle>
                    {groups.map((group) => (
                      <Toggle key={group.id} value={group.id}>
                        {group.name} · {groupCounts.get(group.id) ?? 0}
                      </Toggle>
                    ))}
                  </ToggleGroup>
                </div>
                {canEdit ? (
                  <Button size="xs" variant="ghost" onClick={() => setGroupsOpen(true)}>
                    <TagsIcon />
                    Manage groups
                  </Button>
                ) : null}
              </div>
            ) : null}
            <Input
              aria-label="Search project directory"
              placeholder="Search by project name or path…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <DirectorySelect
                label="Project status"
                value={status}
                options={STATUS_OPTIONS}
                onChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
              />
              <DirectorySelect
                label="Project machine"
                value={environmentId ?? "all"}
                options={machineOptions}
                onChange={(value) => {
                  setEnvironmentId(value === "all" ? null : value);
                  setPage(1);
                }}
              />
              <DirectorySelect
                label="Sort projects"
                value={sort}
                options={SORT_OPTIONS}
                onChange={(value) => {
                  setSort(value);
                  setPage(1);
                }}
              />
              {canEdit ? (
                <Button
                  size="sm"
                  variant={reordering ? "secondary" : "ghost"}
                  aria-pressed={reordering}
                  onClick={() => {
                    setReordering(!reordering);
                    setSort("manual");
                  }}
                >
                  Reorder
                </Button>
              ) : null}
              {query || environmentId !== null || status !== "all" || groupId !== null ? (
                <Button size="sm" variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : null}
              {canEdit && directory.total > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSelection((current) => {
                      const next = new Set(current);
                      for (const key of pageKeys) {
                        if (pageSelected) next.delete(key);
                        else next.add(key);
                      }
                      return next;
                    })
                  }
                >
                  {pageSelected ? "Deselect page" : "Select page"}
                </Button>
              ) : null}
            </div>
          </div>
          {canEdit && selectedKeys.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2"
              role="toolbar"
              aria-label="Selected projects"
            >
              <span className="me-auto text-xs tabular-nums">{selectedKeys.length} selected</span>
              {groups.length > 0 ? (
                <Menu>
                  <MenuTrigger render={<Button size="xs" variant="outline" />}>
                    <FolderInputIcon />
                    Move to group
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {groups.map((group) => (
                      <MenuItem key={group.id} onClick={() => moveSelection(group.id)}>
                        {group.name}
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : (
                <Button size="xs" variant="outline" onClick={() => setGroupsOpen(true)}>
                  <TagsIcon />
                  Create a group
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                disabled={!selectedKeys.some((key) => entries.get(key)?.groupId)}
                onClick={() => moveSelection(null)}
              >
                Remove from group
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setSelection(new Set())}>
                Clear selection
              </Button>
            </div>
          ) : null}
          {directory.total === 0 ? (
            <div className="space-y-2 p-4">
              <p className="text-sm text-muted-foreground">No projects match these filters.</p>
              <Button size="sm" variant="outline" onClick={clearFilters}>
                Clear directory filters
              </Button>
            </div>
          ) : (
            <ul className="divide-y">
              {directory.items.map((project) => {
                const sections = sectionsByProject.get(project.id) ?? [];
                const key = projectEntryKey(project);
                const entry = entries.get(key);
                const manualIndex = manualKeys.indexOf(key);
                const neighborSharesPin = (offset: number) => {
                  const neighbor = manualProjects[manualIndex + offset];
                  return (
                    neighbor !== undefined &&
                    (entries.get(projectEntryKey(neighbor))?.pinned === true) ===
                      (entry?.pinned === true)
                  );
                };
                return (
                  <ProjectSummary
                    key={key}
                    reorder={
                      canEdit && reordering && sort === "manual"
                        ? {
                            up: () =>
                              updateSettings({
                                commandCenter: {
                                  projectOrder: moveProject(projectOrder, manualKeys, key, -1),
                                },
                              }),
                            down: () =>
                              updateSettings({
                                commandCenter: {
                                  projectOrder: moveProject(projectOrder, manualKeys, key, 1),
                                },
                              }),
                            first: !neighborSharesPin(-1),
                            last: !neighborSharesPin(1),
                          }
                        : undefined
                    }
                    project={project}
                    sections={sections}
                    today={today}
                    activeAgents={agentsByProject.get(project.id)?.length ?? 0}
                    waitingSections={sections.filter((section) => unmet.has(section.id)).length}
                    environmentLabel={
                      environmentNames.get(project.environmentId) ?? project.environmentId
                    }
                    selected={detailProjectId === project.id}
                    disabled={lockedProjectId !== null && lockedProjectId !== project.id}
                    onOpen={() => openDetails(project)}
                    pinned={entry?.pinned === true}
                    groupName={entry?.groupId ? (groupNames.get(entry.groupId) ?? null) : null}
                    checked={canEdit ? selection.has(key) : undefined}
                    onCheckedChange={(checked) =>
                      setSelection((current) => {
                        const next = new Set(current);
                        if (checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                );
              })}
            </ul>
          )}
          <div className="border-t px-3">
            <CollectionPager {...directory} label="projects" onPageChange={setPage}>
              <DirectorySelect
                label="Projects per page"
                value={String(pageSize)}
                options={[
                  { value: "10", label: "10 per page" },
                  { value: "20", label: "20 per page" },
                  { value: "50", label: "50 per page" },
                ]}
                onChange={(value) => {
                  if (value === "10" || value === "20" || value === "50") {
                    setPageSize(Number(value) as ProjectDirectoryPageSize);
                    setPage(1);
                  }
                }}
              />
            </CollectionPager>
          </div>
        </section>
        <section
          id="command-center-project-detail"
          tabIndex={-1}
          className="min-w-0 space-y-2"
          aria-label="Project details"
        >
          {detailProject ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-medium">Project details</h2>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={detailEditing}
                  onClick={() => {
                    onDetailChange(null);
                    setEditingSectionId(null);
                    const row = document.getElementById(`cc-project-summary-${detailProject.id}`);
                    (
                      row ?? document.getElementById("command-center-project-directory-heading")
                    )?.focus();
                  }}
                >
                  <XIcon />
                  Close details
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {detailEditing
                  ? "Save or cancel the section edit before switching project details."
                  : "Details stay open while you search or change pages."}
              </p>
              <ProjectCard
                key={detailProject.id}
                project={detailProject}
                sections={sectionsByProject.get(detailProject.id) ?? []}
                agents={agentsByProject.get(detailProject.id) ?? []}
                agentNames={agentNames}
                today={today}
                unmet={unmet}
                onOnboard={startOnboarding}
                editing={editingSectionId}
                onEditingChange={setEditingSectionId}
                entry={entries.get(projectEntryKey(detailProject)) ?? null}
                groupName={
                  groupNames.get(entries.get(projectEntryKey(detailProject))?.groupId ?? "") ?? null
                }
                latestThread={latestThreads.get(projectEntryKey(detailProject))?.shell ?? null}
                canEdit={canEdit}
                onEntryChange={(patch) => changeEntries([projectEntryKey(detailProject)], patch)}
              />
            </>
          ) : detailProjectId !== null ? (
            // Kept, not cleared: the project's machine may still be loading.
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              <span>This project is not available. It was removed or its machine is offline.</span>
              <Button size="sm" variant="ghost" onClick={() => onDetailChange(null)}>
                <XIcon />
                Close details
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              Select a project to view its sections, pending work, agents and actions.
            </div>
          )}
        </section>
      </div>
      <ProjectGroupsDialog
        open={groupsOpen}
        onOpenChange={setGroupsOpen}
        groups={groups}
        entries={entryList}
        counts={groupCounts}
      />
      {directory.total > 0 ? (
        <DeliveryStrip
          projects={directory.items}
          sectionsByProject={sectionsByProject}
          today={today}
          lockedProjectId={lockedProjectId}
          onOpen={(project) => {
            openDetails(project);
            document
              .getElementById("command-center-project-detail")
              ?.scrollIntoView({ block: "start" });
          }}
        />
      ) : null}
    </div>
  );
}
