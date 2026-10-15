import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  CommandCenterAgentId,
  CommandCenterSection,
  CommandCenterSectionStatus,
  ProjectId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ExternalLinkIcon,
  LinkIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SendHorizontalIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../../pullRequest/pullRequestListPreferences";
import { RunWorkflowMenu } from "../../RunWorkflowDialog";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { isHttpUrl } from "../customization";
import type { CommandCenterAgentState } from "../logic";
import { useCommandCenter, useCommandCenterCommands } from "../shared";
import {
  daysBetween,
  delegationSteps,
  dueLabel,
  parseMissing,
  projectHealth,
  type ProjectHealthLevel,
  projectProgress,
  SECTION_STATUS_LABEL,
  whereWeLeftOff,
} from "./logic";
import type { ProjectEntry } from "./projectDirectory";
import { ProjectPreviewButton } from "./ProjectPreview";
import { ProjectSchedules } from "./ProjectSchedules";
import { ProjectInstructions } from "./ProjectInstructions";
import { AddProjectOnMachine } from "./AddProjectOnMachine";
import { SectionPullRequest } from "./SectionPullRequest";
import { selectSectionPage } from "./sectionDirectory";

export const STATUS_BADGE = {
  todo: "outline",
  in_progress: "info",
  review: "warning",
  blocked: "error",
  done: "success",
} as const satisfies Record<CommandCenterSectionStatus, string>;

const STATUSES = Object.keys(SECTION_STATUS_LABEL) as CommandCenterSectionStatus[];

const HEALTH_DOT = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
} as const satisfies Record<ProjectHealthLevel, string>;

const HEALTH_LABEL = {
  green: "On track",
  amber: "At risk",
  red: "Needs attention",
} as const satisfies Record<ProjectHealthLevel, string>;

/** Detail lists show this many rows per page; agent badges show this many plus "+N". */
const DETAIL_PAGE_SIZE = 5;
const MAX_AGENT_BADGES = 6;

type UnmetDependencies = ReadonlyMap<
  CommandCenterSection["id"],
  ReadonlyArray<CommandCenterSection>
>;

export function ProgressBar({ percent, danger = false }: { percent: number; danger?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", danger ? "bg-destructive" : "bg-primary")}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

export function ProjectCard({
  project,
  sections,
  agents,
  agentNames,
  today,
  unmet,
  onOnboard,
  editing,
  onEditingChange,
  entry,
  groupName,
  latestThread,
  canEdit,
  onEntryChange,
}: {
  readonly project: EnvironmentProject;
  readonly sections: ReadonlyArray<CommandCenterSection>;
  readonly agents: ReadonlyArray<CommandCenterAgentState & { agentId: CommandCenterAgentId }>;
  readonly agentNames: ReadonlyMap<CommandCenterAgentId, string>;
  readonly today: string;
  /** Unmet dependencies of every section (all projects). */
  readonly unmet: UnmetDependencies;
  /** Starts the Onboarding team on this project; resolves when the Lead thread exists or failed. */
  readonly onOnboard: (projectId: ProjectId) => Promise<boolean>;
  readonly editing: CommandCenterSection["id"] | "new" | null;
  readonly onEditingChange: (editing: CommandCenterSection["id"] | "new" | null) => void;
  /** Pin, group and link saved in the primary settings; null when never customized. */
  readonly entry: ProjectEntry | null;
  readonly groupName: string | null;
  readonly latestThread: EnvironmentThreadShell | null;
  /** Whether this client may change the primary settings. */
  readonly canEdit: boolean;
  /** Saves the patch; false when it was refused (the customized-projects cap). */
  readonly onEntryChange: (patch: Partial<Omit<ProjectEntry, "key">>) => boolean;
}) {
  const { snapshot, projects, canOperate, openPlan } = useCommandCenter();
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const [todoPage, setTodoPage] = useState(1);
  const { setMemoryDone } = useCommandCenterCommands();
  const changeEditing = onEditingChange;
  const progress = projectProgress(sections);
  const leftOff = whereWeLeftOff(snapshot.memory, project.id);
  const delegation = delegationSteps(sections, leftOff.todos);
  const nextSortKey = sections.reduce((max, section) => Math.max(max, section.sortKey), 0) + 1;
  const health = projectHealth({
    sections,
    today,
    activeAgents: agents.length,
    waitingSections: sections.filter((section) => unmet.has(section.id)).length,
  });
  const projectTitle = (id: CommandCenterSection["projectId"]) =>
    projects.find((candidate) => candidate.id === id)?.title ?? "Unknown project";
  const [onboarding, setOnboarding] = useState(false);
  const [sectionSearch, setSectionSearch] = useState("");
  const [sectionStatus, setSectionStatus] = useState<CommandCenterSectionStatus | "all">("all");
  const [sectionPage, setSectionPage] = useState(1);
  const directory = selectSectionPage({
    sections,
    search: sectionSearch,
    status: sectionStatus,
    page: sectionPage,
    editing,
  });
  const todos = paginateCollection(leftOff.todos, todoPage, DETAIL_PAGE_SIZE);
  const pinned = entry?.pinned === true;
  const onboard = () => {
    setOnboarding(true);
    void onOnboard(project.id).finally(() => setOnboarding(false));
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              // Focusable so keyboard users reach the tooltip; the reasons are read out too.
              <button
                type="button"
                className={cn("size-2.5 shrink-0 rounded-full", HEALTH_DOT[health.level])}
              >
                <span className="sr-only">
                  {[HEALTH_LABEL[health.level], ...health.reasons].join(". ")}
                </span>
              </button>
            }
          />
          <TooltipPopup>
            <p className="font-medium">{HEALTH_LABEL[health.level]}</p>
            {health.reasons.slice(0, 3).map((reason, index) => (
              // oxlint-disable-next-line no-array-index-key -- two sections can share a reason
              <p key={index}>{reason}</p>
            ))}
            {health.reasons.length > 3 ? <p>+{health.reasons.length - 3} more</p> : null}
          </TooltipPopup>
        </Tooltip>
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight">{project.title}</h2>
        {pinned ? <PinIcon aria-label="Pinned" className="size-3.5 text-muted-foreground" /> : null}
        {groupName ? <Badge variant="outline">{groupName}</Badge> : null}
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {agents.slice(0, MAX_AGENT_BADGES).map((agent) => (
            <Badge
              key={agent.agentId}
              variant={
                agent.status === "blocked"
                  ? "error"
                  : agent.status === "working"
                    ? "info"
                    : "warning"
              }
            >
              {agentNames.get(agent.agentId) ?? "Agent"} · {agent.status}
            </Badge>
          ))}
          {agents.length > MAX_AGENT_BADGES ? (
            <Badge variant="outline">+{agents.length - MAX_AGENT_BADGES}</Badge>
          ) : null}
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={delegation.length === 0}
          onClick={() => openPlan({ projectId: project.id, steps: delegation })}
        >
          <SendHorizontalIcon />
          Ask the team
        </Button>
        <Button size="xs" variant="outline" disabled={!canOperate || onboarding} onClick={onboard}>
          <SparklesIcon />
          Onboard
        </Button>
        <RunWorkflowMenu environmentId={project.environmentId} projectId={project.id} />
        <ProjectPreviewButton project={project} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={latestThread === null}
          onClick={() => {
            if (latestThread === null) return;
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(latestThread.environmentId, latestThread.id),
              ),
            });
          }}
        >
          <MessageSquareIcon />
          Open latest thread
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void newThread(scopeProjectRef(project.environmentId, project.id))}
        >
          <MessageSquarePlusIcon />
          New thread
        </Button>
        {entry?.url ? (
          <Button
            size="xs"
            variant="outline"
            render={<a href={entry.url} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLinkIcon />
            Open site
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/pull-requests",
              search: {
                ...readPullRequestListPreferences(),
                projectId: project.id,
                environmentId: project.environmentId,
              },
            })
          }
        >
          <PullRequestGlyph.pullRequest />
          Pull requests
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigate({
              to: "/settings/projects",
              search: {
                project: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
                machine: project.environmentId,
              },
            })
          }
        >
          <SettingsIcon />
          Project settings
        </Button>
        {canEdit ? (
          <Button size="xs" variant="ghost" onClick={() => onEntryChange({ pinned: !pinned })}>
            {pinned ? <PinOffIcon /> : <PinIcon />}
            {pinned ? "Unpin" : "Pin"}
          </Button>
        ) : null}
        {canEdit ? (
          <ProjectLinkEditor url={entry?.url ?? null} onChange={(url) => onEntryChange({ url })} />
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            Progress <span className="font-medium text-foreground">{progress.percent}%</span> (
            {progress.done}/{progress.total} tasks)
          </span>
          <span>
            {progress.delivered}/{sections.length} sections done
          </span>
        </div>
        <ProgressBar percent={progress.percent} />
      </div>

      <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-3 text-sm">
        <span className="text-xs font-medium text-muted-foreground">Where we left off</span>
        {leftOff.progress ? (
          <p className="whitespace-pre-wrap">
            {leftOff.progress.text}{" "}
            <span className="text-xs text-muted-foreground">
              {formatRelativeTimeLabel(leftOff.progress.createdAt)}
            </span>
          </p>
        ) : (
          <p className="text-muted-foreground">No progress saved yet.</p>
        )}
        {leftOff.digest ? (
          <p className="text-xs text-muted-foreground">
            {leftOff.digest.text} {formatRelativeTimeLabel(leftOff.digest.createdAt)}
          </p>
        ) : null}
        {todos.items.map((todo) => (
          <label key={todo.id} className="flex items-start gap-2">
            <Checkbox
              checked={false}
              disabled={!canOperate}
              aria-label={`Mark "${todo.text}" done`}
              onCheckedChange={(checked) => {
                if (checked) void setMemoryDone({ id: todo.id, done: true });
              }}
            />
            <span className="min-w-0">{todo.text}</span>
          </label>
        ))}
        {todos.pageCount > 1 ? (
          <CollectionPager {...todos} label="open todos" onPageChange={setTodoPage} />
        ) : null}
      </div>

      <ProjectSchedules project={project} />
      <ProjectInstructions key={`${project.environmentId}:${project.id}`} project={project} />
      <AddProjectOnMachine project={project} />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <h3 className="text-sm font-medium">
          Sections <span className="text-muted-foreground">({sections.length})</span>
        </h3>
        {canOperate && editing !== "new" ? (
          <Button size="xs" variant="outline" onClick={() => changeEditing("new")}>
            <PlusIcon />
            Add section
          </Button>
        ) : null}
      </div>
      {sections.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          <div className="min-w-40 flex-1">
            <Input
              size="sm"
              type="search"
              aria-label="Search project sections"
              placeholder="Search sections, blockers or pending work…"
              value={sectionSearch}
              onChange={(event) => {
                setSectionSearch(event.target.value);
                setSectionPage(1);
              }}
            />
          </div>
          <Select
            value={sectionStatus}
            onValueChange={(value) => {
              setSectionStatus(STATUSES.find((item) => item === value) ?? "all");
              setSectionPage(1);
            }}
          >
            <SelectTrigger size="sm" aria-label="Filter section status">
              <SelectValue>
                {sectionStatus === "all" ? "All statuses" : SECTION_STATUS_LABEL[sectionStatus]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {SECTION_STATUS_LABEL[status]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      <div className="flex flex-col divide-y">
        {directory.visible.map((section) =>
          editing === section.id ? (
            <SectionForm
              key={section.id}
              project={project}
              section={section}
              sortKey={section.sortKey}
              onDone={() => changeEditing(null)}
            />
          ) : (
            <SectionRow
              key={section.id}
              project={project}
              section={section}
              waitingOn={(unmet.get(section.id) ?? []).map((dependency) =>
                dependency.projectId === project.id
                  ? dependency.name
                  : `${projectTitle(dependency.projectId)} · ${dependency.name}`,
              )}
              today={today}
              onEdit={canOperate ? () => changeEditing(section.id) : undefined}
            />
          ),
        )}
        {editing === "new" ? (
          <SectionForm project={project} sortKey={nextSortKey} onDone={() => changeEditing(null)} />
        ) : null}
      </div>
      {sections.length > 0 && directory.total === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
          <p>No sections match your filters.</p>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setSectionSearch("");
              setSectionStatus("all");
              setSectionPage(1);
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}
      {directory.total > 0 ? (
        <div className="border-t">
          <CollectionPager
            {...directory}
            label="matching sections"
            disabled={editing !== null}
            onPageChange={setSectionPage}
          />
        </div>
      ) : null}
      {sections.length === 0 && editing !== "new" ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1">
            No sections yet. Onboarding maps the repo into sections and todos.
          </span>
          <Button size="xs" disabled={!canOperate || onboarding} onClick={onboard}>
            <SparklesIcon />
            Onboard this project
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** "Link site" opens an inline editor; a saved link can be edited or cleared. */
function ProjectLinkEditor({
  url,
  onChange,
}: {
  readonly url: string | null;
  /** False when the save was refused; the editor then keeps the draft. */
  readonly onChange: (url: string | null) => boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <>
        <Button size="xs" variant="ghost" onClick={() => setDraft(url ?? "")}>
          <LinkIcon />
          {url ? "Edit link" : "Link site"}
        </Button>
        {url ? (
          <Button size="xs" variant="ghost-destructive" onClick={() => onChange(null)}>
            Clear link
          </Button>
        ) : null}
      </>
    );
  }
  const invalid = draft.trim() !== "" && !isHttpUrl(draft);
  return (
    <form
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (isHttpUrl(draft) && onChange(draft.trim())) setDraft(null);
      }}
    >
      <div className="min-w-48 flex-1">
        <Input
          size="sm"
          type="url"
          autoFocus
          aria-label="Site or admin link"
          aria-invalid={invalid || undefined}
          placeholder="https://admin.example.com"
          maxLength={2_000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>
      <Button type="submit" size="xs" disabled={!isHttpUrl(draft)}>
        Save link
      </Button>
      <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
        Cancel
      </Button>
      {invalid ? (
        <p className="w-full text-xs text-destructive-foreground">
          Enter a complete http:// or https:// link.
        </p>
      ) : null}
    </form>
  );
}

function SectionRow({
  project,
  section,
  waitingOn,
  today,
  onEdit,
}: {
  readonly project: EnvironmentProject;
  readonly section: CommandCenterSection;
  /** Labels of the unfinished sections this one depends on. */
  readonly waitingOn: ReadonlyArray<string>;
  readonly today: string;
  readonly onEdit: (() => void) | undefined;
}) {
  const days = section.dueDate === null ? null : daysBetween(today, section.dueDate);
  const open = section.status !== "done";
  const percent = section.tasksTotal === 0 ? 0 : (section.tasksDone / section.tasksTotal) * 100;
  return (
    <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-2.5 text-sm sm:grid-cols-[6rem_minmax(0,1fr)_8rem_6.5rem_auto]">
      <div>
        <Badge variant={STATUS_BADGE[section.status]}>{SECTION_STATUS_LABEL[section.status]}</Badge>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{section.name}</span>
        {section.blocker ? (
          <span className="text-xs text-destructive-foreground">Blocked: {section.blocker}</span>
        ) : null}
        {waitingOn.length > 0 ? (
          <span className="text-xs text-warning-foreground">Waiting on {waitingOn.join(", ")}</span>
        ) : null}
        {section.trying ? (
          <span className="text-xs text-muted-foreground">Trying: {section.trying}</span>
        ) : null}
        {open && section.missing.length > 0 ? (
          <ul className="list-disc ps-4 text-xs text-muted-foreground">
            {section.missing.map((item, index) => (
              // oxlint-disable-next-line no-array-index-key -- missing items are plain strings that may repeat
              <li key={index}>{item}</li>
            ))}
          </ul>
        ) : null}
        <SectionPullRequest section={section} project={project} />
      </div>
      <div className="col-start-2 flex flex-col gap-1 sm:col-start-auto">
        <ProgressBar percent={percent} danger={section.status === "blocked"} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {section.tasksDone}/{section.tasksTotal} tasks
        </span>
      </div>
      <div className="col-start-2 text-xs sm:col-start-auto">
        {section.dueDate === null || days === null ? (
          <span className="text-muted-foreground">No due date</span>
        ) : (
          <>
            <div
              className={cn(
                "tabular-nums",
                open && days < 0 && "text-destructive-foreground",
                open && days >= 0 && days <= 7 && "text-warning-foreground",
              )}
            >
              {section.dueDate}
            </div>
            <div className="text-muted-foreground">{open ? dueLabel(days) : "delivered"}</div>
          </>
        )}
      </div>
      <div className="col-start-2 sm:col-start-auto">
        {onEdit ? (
          <Button size="icon-xs" variant="ghost-muted" aria-label="Edit section" onClick={onEdit}>
            <PencilIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const toCount = (text: string) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= 0 ? value : null;
};

function SectionForm({
  project,
  section,
  sortKey,
  onDone,
}: {
  readonly project: EnvironmentProject;
  readonly section?: CommandCenterSection;
  readonly sortKey: number;
  readonly onDone: () => void;
}) {
  const { upsert, removeWithUndo } = useCommandCenterCommands();
  const { snapshot, projects } = useCommandCenter();
  const [name, setName] = useState(section?.name ?? "");
  const [status, setStatus] = useState<CommandCenterSectionStatus>(section?.status ?? "todo");
  const [tasksDone, setTasksDone] = useState(String(section?.tasksDone ?? 0));
  const [tasksTotal, setTasksTotal] = useState(String(section?.tasksTotal ?? 0));
  const [dueDate, setDueDate] = useState(section?.dueDate ?? "");
  const [trying, setTrying] = useState(section?.trying ?? "");
  const [blocker, setBlocker] = useState(section?.blocker ?? "");
  const [missing, setMissing] = useState(section?.missing.join("\n") ?? "");
  const [dependsOn, setDependsOn] = useState<ReadonlyArray<CommandCenterSection["id"]>>(
    section?.dependsOn ?? [],
  );
  // Sections of every project, grouped by project, this one could wait on.
  const candidates = projects.flatMap((candidate) => {
    const options = snapshot.sections.filter(
      (other) => other.projectId === candidate.id && other.id !== section?.id,
    );
    return options.length > 0 ? [{ project: candidate, options }] : [];
  });
  const [busy, setBusy] = useState(false);

  const done = toCount(tasksDone);
  const total = toCount(tasksTotal);
  const valid = name.trim().length > 0 && done !== null && total !== null;

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    const result = await upsert({
      entity: "section",
      value: {
        ...(section ? { id: section.id } : {}),
        projectId: project.id,
        name: name.trim(),
        status,
        tasksDone: done,
        tasksTotal: total,
        dueDate: dueDate || null,
        trying: trying.trim() || null,
        blocker: blocker.trim() || null,
        missing: parseMissing(missing),
        dependsOn: [...dependsOn],
        sortKey,
      },
    });
    setBusy(false);
    if (result._tag === "Success") onDone();
  };

  const removeSection = async () => {
    if (!section) return;
    setBusy(true);
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = section;
    const deleted = await removeWithUndo(
      { entity: "section", id: section.id },
      { entity: "section", value },
      `Deleted ${section.name}`,
    );
    setBusy(false);
    if (deleted) onDone();
  };

  return (
    <form
      className="flex flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <Input
          size="sm"
          aria-label="Section name"
          placeholder="Section name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Select
          value={status}
          onValueChange={(value) => {
            const next = STATUSES.find((candidate) => candidate === value);
            if (next) setStatus(next);
          }}
        >
          <SelectTrigger aria-label="Status" size="sm">
            <SelectValue>{SECTION_STATUS_LABEL[status]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {SECTION_STATUS_LABEL[value]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Tasks done
          <Input
            size="sm"
            type="number"
            min={0}
            value={tasksDone}
            onChange={(event) => setTasksDone(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Tasks total
          <Input
            size="sm"
            type="number"
            min={0}
            value={tasksTotal}
            onChange={(event) => setTasksTotal(event.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          Due date
          <Input
            size="sm"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </label>
      </div>
      <Input
        size="sm"
        aria-label="What is being tried"
        placeholder="What is being tried"
        value={trying}
        onChange={(event) => setTrying(event.target.value)}
      />
      <Input
        size="sm"
        aria-label="Blocker"
        placeholder="Blocker"
        value={blocker}
        onChange={(event) => setBlocker(event.target.value)}
      />
      <Textarea
        size="sm"
        aria-label="What is missing"
        placeholder="What is missing, one item per line"
        value={missing}
        onChange={(event) => setMissing(event.target.value)}
      />
      {candidates.length > 0 ? (
        <fieldset className="flex flex-col gap-1 text-xs text-muted-foreground">
          <legend className="mb-1">Waits on</legend>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
            {candidates.map(({ project: candidate, options }) => (
              <div key={candidate.id} className="flex flex-col gap-1">
                <span className="font-medium text-foreground">{candidate.title}</span>
                {options.map((option) => (
                  <label key={option.id} className="flex items-center gap-2 ps-2">
                    <Checkbox
                      checked={dependsOn.includes(option.id)}
                      onCheckedChange={(checked) =>
                        setDependsOn((current) =>
                          checked
                            ? [...current, option.id]
                            : current.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span className="min-w-0 truncate">
                      {option.name} · {SECTION_STATUS_LABEL[option.status]}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="xs" disabled={busy || !valid}>
          Save
        </Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <div className="flex-1" />
        {section ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-destructive"
            disabled={busy}
            onClick={() => void removeSection()}
          >
            Remove section
          </Button>
        ) : null}
      </div>
    </form>
  );
}
