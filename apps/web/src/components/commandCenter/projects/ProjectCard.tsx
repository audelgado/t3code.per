import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  CommandCenterAgentId,
  CommandCenterSection,
  CommandCenterSectionStatus,
  ProjectId,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon, SendHorizontalIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Textarea } from "../../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
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

type UnmetDependencies = ReadonlyMap<
  CommandCenterSection["id"],
  ReadonlyArray<CommandCenterSection>
>;

export const projectAnchorId = (project: EnvironmentProject) => `cc-project-${project.id}`;

function ProgressBar({ percent, danger = false }: { percent: number; danger?: boolean }) {
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
  dimmed,
  unmet,
  onOnboard,
}: {
  readonly project: EnvironmentProject;
  readonly sections: ReadonlyArray<CommandCenterSection>;
  readonly agents: ReadonlyArray<CommandCenterAgentState & { agentId: CommandCenterAgentId }>;
  readonly agentNames: ReadonlyMap<CommandCenterAgentId, string>;
  readonly today: string;
  readonly dimmed: boolean;
  /** Unmet dependencies of every section (all projects). */
  readonly unmet: UnmetDependencies;
  /** Starts the Onboarding team on this project; resolves when the Lead thread exists or failed. */
  readonly onOnboard: (projectId: ProjectId) => Promise<boolean>;
}) {
  const { snapshot, projects, canOperate, openPlan } = useCommandCenter();
  const { setMemoryDone } = useCommandCenterCommands();
  const [editing, setEditing] = useState<CommandCenterSection["id"] | "new" | null>(null);
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
  const onboard = () => {
    setOnboarding(true);
    void onOnboard(project.id).finally(() => setOnboarding(false));
  };

  return (
    <section
      id={projectAnchorId(project)}
      className={cn("flex flex-col gap-3 rounded-xl border bg-card p-4", dimmed && "opacity-50")}
    >
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
            {health.reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </TooltipPopup>
        </Tooltip>
        <h2 className="min-w-0 truncate font-medium">{project.title}</h2>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {agents.map((agent) => (
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
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={delegation.length === 0}
          onClick={() => openPlan({ projectId: project.id, steps: delegation })}
        >
          <SendHorizontalIcon />
          Delegate what's missing
        </Button>
        <Button size="xs" variant="outline" disabled={!canOperate || onboarding} onClick={onboard}>
          <SparklesIcon />
          Onboard
        </Button>
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
        {leftOff.todos.map((todo) => (
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
      </div>

      <div className="flex flex-col divide-y">
        {sections.map((section) =>
          editing === section.id ? (
            <SectionForm
              key={section.id}
              project={project}
              section={section}
              sortKey={section.sortKey}
              onDone={() => setEditing(null)}
            />
          ) : (
            <SectionRow
              key={section.id}
              section={section}
              waitingOn={(unmet.get(section.id) ?? []).map((dependency) =>
                dependency.projectId === project.id
                  ? dependency.name
                  : `${projectTitle(dependency.projectId)} · ${dependency.name}`,
              )}
              today={today}
              onEdit={canOperate ? () => setEditing(section.id) : undefined}
            />
          ),
        )}
        {editing === "new" ? (
          <SectionForm project={project} sortKey={nextSortKey} onDone={() => setEditing(null)} />
        ) : null}
      </div>
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
      {canOperate && editing !== "new" ? (
        <div>
          <Button size="xs" variant="ghost-muted" onClick={() => setEditing("new")}>
            <PlusIcon />
            Add section
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function SectionRow({
  section,
  waitingOn,
  today,
  onEdit,
}: {
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
