import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CommandCenterAttention,
  COMMAND_CENTER_QUESTION_PREFIX,
} from "@t3tools/client-runtime/state/commandCenterDerive";
import type {
  CommandCenterMemoryEntry,
  CommandCenterSection,
  CommandCenterWorkflowRun,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { openCommandPalette } from "~/commandPaletteBus";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Empty, EmptyDescription } from "../../ui/empty";
import { Input } from "../../ui/input";
import { CollectionPager } from "../CollectionPager";
import { paginateKeepingRow } from "../collectionPaging";
import type { QuickAction } from "../customization";
import { displayCurrency, financeSummary } from "../finance/logic";
import { PendingRequestAnswer } from "../team/PendingRequestAnswer";
import type { CommandCenterTab } from "../tabs";
import {
  Money,
  useCommandCenter,
  useCommandCenterAttention,
  useCommandCenterCommands,
  useCommandCenterEnvironments,
} from "../shared";
import { StatusDot } from "../StatusDot";
import { deriveWorkItems } from "../work/workItems";
import { completedBuckets, nowCounts, pinnedProjects } from "./homeLogic";
import { LaunchGrid } from "./LaunchGrid";
import { NowCounters } from "./NowCounters";
import { PinnedGrid } from "./PinnedGrid";
import { ShortcutHints } from "./ShortcutHints";

const NEEDS_YOU_PAGE = 5;
const MAX_TODOS = 5;
const NEEDS_YOU_ID = "command-center-needs-you";
const REASON_LABEL = {
  approval: "Needs approval",
  input: "Asks a question",
  plan: "Plan ready",
} as const;

/** Home derives its overview from existing shells, settings and the CC snapshot. */
export function HomeTab({
  quickActions,
  onRunQuickAction,
  onMoreQuickActions,
  onTabChange,
  onOpenTodos,
}: {
  readonly quickActions: readonly QuickAction[];
  readonly onRunQuickAction: (action: QuickAction) => void;
  readonly onMoreQuickActions: () => void;
  readonly onTabChange: (tab: CommandCenterTab) => void;
  readonly onOpenTodos: () => void;
}) {
  const { snapshot, projects, projectId, canOperate } = useCommandCenter();
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const shells = useThreadShells();
  const attention = useCommandCenterAttention();
  const now = useRelativeTimeTick(60_000);
  const settings = usePrimarySettings((value) => value.commandCenter);
  const pinned = useMemo(
    () => pinnedProjects(settings.projects, projects, settings.projectOrder),
    [settings.projects, settings.projectOrder, projects],
  );
  const items = useMemo(() => deriveWorkItems(shells, projects), [shells, projects]);
  const counts = useMemo(() => nowCounts(shells, attention, items), [shells, attention, items]);
  const completed = useMemo(() => completedBuckets(shells, now), [shells, now]);
  const todos = useMemo(
    () =>
      snapshot.memory
        .filter(
          (entry) =>
            entry.kind === "todo" &&
            !entry.done &&
            !entry.text.startsWith(COMMAND_CENTER_QUESTION_PREFIX),
        )
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [snapshot.memory],
  );
  const currency = displayCurrency(snapshot.income, snapshot.costs);
  const { owedCents } = useMemo(
    () => financeSummary(snapshot.income, snapshot.costs, currency, new Date(now)),
    [currency, now, snapshot.costs, snapshot.income],
  );
  const totalIncome = snapshot.income
    .filter((row) => row.currency === currency)
    .reduce((sum, row) => sum + row.amountCents, 0);
  const projectTitle = (id: ProjectId | null) =>
    projects.find((project) => project.id === id)?.title ?? null;
  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  const openProject = useCallback(
    (id: ProjectId) => void navigate({ to: "/command", search: { tab: "projects", project: id } }),
    [navigate],
  );
  const startThread = useCallback(
    (worktree: boolean) => {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project)
        void newThread(
          scopeProjectRef(project.environmentId, project.id),
          worktree ? { envMode: "worktree" } : undefined,
        );
      else openCommandPalette({ open: "new-thread-in" });
    },
    [projects, projectId, newThread],
  );
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.closest(
            'input, textarea, select, [role="dialog"], [aria-modal="true"], [data-slot$="popup"]',
          ))
      )
        return;
      const index = Number(event.key) - 1;
      if (/^[1-8]$/.test(event.key) && pinned[index]) {
        event.preventDefault();
        openProject(pinned[index]!.id);
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        startThread(true);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pinned, openProject, startThread]);
  return (
    <div className="flex flex-col gap-6">
      <ShortcutHints />
      <NowCounters
        counts={counts}
        completed={completed}
        owedCents={owedCents}
        currency={currency}
        owedFraction={totalIncome > 0 ? owedCents / totalIncome : 0}
        onTabChange={onTabChange}
        onNeedsYou={() => document.getElementById(NEEDS_YOU_ID)?.scrollIntoView({ block: "start" })}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-2">
        <NeedsYou
          items={attention}
          projectTitle={projectTitle}
          onOpenThread={openThread}
          onOpenProject={openProject}
          onOpenRun={(run) =>
            void navigate({
              to: "/command",
              search: { tab: "workflows", project: run.projectId, run: run.id },
            })
          }
          onOpenFinance={() => onTabChange("finance")}
        />
        <HomeBlock
          title="Pinned"
          className="lg:col-span-2"
          surface={false}
          action={
            <Button size="xs" variant="ghost" onClick={() => onTabChange("projects")}>
              All projects
            </Button>
          }
        >
          <PinnedGrid
            projects={pinned}
            shells={shells}
            items={items}
            now={now}
            onOpen={openProject}
          />
        </HomeBlock>
        <HomeBlock title="Launch" surface={false}>
          <LaunchGrid
            actions={quickActions}
            onRun={onRunQuickAction}
            onMore={onMoreQuickActions}
            onNewThread={() => startThread(false)}
            onNewWork={() => startThread(true)}
          />
        </HomeBlock>
        {todos.length > 0 || canOperate ? (
          <TodosBlock
            todos={todos.slice(0, MAX_TODOS)}
            total={todos.length}
            projectTitle={projectTitle}
            focusProjectId={projectId}
            onOpenTodos={onOpenTodos}
          />
        ) : null}
      </div>
    </div>
  );
}

function HomeBlock({
  title,
  action,
  id,
  className,
  children,
  surface = true,
}: {
  readonly surface?: boolean;
  readonly title: string;
  readonly action?: ReactNode;
  readonly id?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} aria-label={title} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-normal text-foreground/70">{title}</h3>
        {action}
      </div>
      {surface ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-4">{children}</div>
      ) : (
        children
      )}
    </section>
  );
}

/** Attention rows, five per page; an open inline answer stays on whatever page it started. */
export function NeedsYou({
  items,
  projectTitle,
  onOpenThread,
  onOpenProject,
  onOpenRun,
  onOpenFinance,
}: {
  readonly items: ReadonlyArray<CommandCenterAttention>;
  readonly projectTitle: (id: ProjectId | null) => string | null;
  readonly onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
  readonly onOpenProject: (projectId: ProjectId) => void;
  readonly onOpenRun: (run: CommandCenterWorkflowRun) => void;
  readonly onOpenFinance: () => void;
}) {
  const { snapshot, canOperate } = useCommandCenter();
  const commands = useCommandCenterCommands();
  const environments = useCommandCenterEnvironments();
  const navigate = useNavigate();
  // One inline answer at a time, so only one thread's detail is subscribed.
  const [answering, setAnswering] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const directory = paginateKeepingRow(items, page, NEEDS_YOU_PAGE, answering, (item) => item.key);
  const agentName = (id: string) =>
    snapshot.agentProfiles.find((agent) => agent.id === id)?.name ?? "An agent";
  const resolve = (section: CommandCenterSection) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...value } = section;
    void commands.upsert({
      entity: "section",
      value: { ...value, status: "in_progress", blocker: null },
    });
  };
  const openButton = (label: string, onClick: () => void) => (
    <Button size="xs" variant="outline" onClick={onClick}>
      {label}
    </Button>
  );

  const row = (item: CommandCenterAttention) => {
    switch (item.kind) {
      case "thread": {
        const { shell } = item;
        const canAnswer = item.reason !== "plan";
        return (
          <AttentionRow
            key={item.key}
            text={shell.title}
            detail={[
              REASON_LABEL[item.reason],
              projectTitle(shell.projectId),
              environments.find((environment) => environment.environmentId === shell.environmentId)
                ?.label,
            ]
              .filter(Boolean)
              .join(" · ")}
            action={
              <>
                {canAnswer ? (
                  <Button
                    size="xs"
                    variant={answering === item.key ? "secondary" : "outline"}
                    aria-expanded={answering === item.key}
                    onClick={() =>
                      setAnswering((current) => (current === item.key ? null : item.key))
                    }
                  >
                    Answer
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant={canAnswer ? "ghost" : "outline"}
                  onClick={() => onOpenThread(shell.environmentId, shell.id)}
                >
                  Open thread
                </Button>
              </>
            }
          >
            {answering === item.key ? (
              <PendingRequestAnswer environmentId={shell.environmentId} threadId={shell.id} />
            ) : null}
          </AttentionRow>
        );
      }
      case "run":
        return (
          <AttentionRow
            key={item.key}
            text={`${item.run.title} is waiting for you`}
            detail={["Workflow run", projectTitle(item.run.projectId)].filter(Boolean).join(" · ")}
            action={openButton("Open run", () => onOpenRun(item.run))}
          />
        );
      case "offline":
        return (
          <AttentionRow
            key={item.key}
            tone="alert"
            text={`${item.label} is disconnected`}
            detail="Its teams and agents cannot be reached"
            action={openButton("Reconnect", () => void navigate({ to: "/settings/connections" }))}
          />
        );
      case "stuck": {
        const { assignment } = item;
        return (
          <AttentionRow
            key={item.key}
            tone="alert"
            text={`${agentName(item.agentId)} has shown no activity for ${item.minutes} min`}
            detail={assignment?.task ?? null}
            action={
              assignment
                ? openButton("Open thread", () =>
                    onOpenThread(assignment.environmentId, assignment.threadId),
                  )
                : null
            }
          />
        );
      }
      case "delivery":
        return (
          <AttentionRow
            key={item.key}
            tone="alert"
            text={`${item.section.name} is due ${
              item.days === 0 ? "today" : item.days === 1 ? "tomorrow" : `in ${item.days} days`
            } at ${item.percent}%`}
            detail={projectTitle(item.section.projectId)}
            action={openButton("Open project", () => onOpenProject(item.section.projectId))}
          />
        );
      case "question": {
        const assignment = item.entry.threadId
          ? snapshot.assignments.find((candidate) => candidate.threadId === item.entry.threadId)
          : undefined;
        return (
          <AttentionRow
            key={item.key}
            text={item.entry.text.slice(COMMAND_CENTER_QUESTION_PREFIX.length)}
            detail={["Question", projectTitle(item.entry.projectId)].filter(Boolean).join(" · ")}
            action={
              assignment
                ? openButton("Open thread", () =>
                    onOpenThread(assignment.environmentId, assignment.threadId),
                  )
                : null
            }
          />
        );
      }
      case "blocked":
        return (
          <AttentionRow
            key={item.key}
            text={`${item.section.name} is blocked`}
            detail={[projectTitle(item.section.projectId), item.section.blocker]
              .filter(Boolean)
              .join(" · ")}
            action={
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canOperate}
                  onClick={() => resolve(item.section)}
                >
                  <CheckIcon />
                  Resolved
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => onOpenProject(item.section.projectId)}
                >
                  Open project
                </Button>
              </>
            }
          />
        );
      case "overdue":
        return (
          <AttentionRow
            key={item.key}
            tone="alert"
            text={`${item.income.concept} is overdue`}
            detail={
              <>
                {item.income.clientName} ·{" "}
                <Money cents={item.income.amountCents} currency={item.income.currency} />
              </>
            }
            action={openButton("Open Finance", onOpenFinance)}
          />
        );
    }
  };

  return (
    <HomeBlock id={NEEDS_YOU_ID} title="Needs you" className="lg:col-span-2">
      {items.length ? (
        <ul className="divide-y text-sm">{directory.items.map(row)}</ul>
      ) : (
        <Empty>
          <EmptyDescription>Nothing needs you right now</EmptyDescription>
        </Empty>
      )}
      {directory.pageCount > 1 ? (
        <CollectionPager {...directory} label="items" onPageChange={setPage} />
      ) : null}
    </HomeBlock>
  );
}

function AttentionRow({
  text,
  detail,
  action,
  tone = "default",
  children,
}: {
  readonly text: string;
  readonly detail: ReactNode;
  readonly action: ReactNode;
  readonly tone?: "default" | "alert";
  /** Shown under the row, such as an inline answer. */
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 basis-48">
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot
              tone={tone === "alert" ? "destructive" : "warning"}
              label={tone === "alert" ? "Alert" : "Needs you"}
              hideLabel
            />
            <span className="truncate">{text}</span>
          </span>
          {detail ? (
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 gap-1">{action}</span>
      </div>
      {children}
    </li>
  );
}

/** Newest open todos with a check, a quick add, and the full list in Memory. */
function TodosBlock({
  todos,
  total,
  projectTitle,
  focusProjectId,
  onOpenTodos,
}: {
  readonly todos: ReadonlyArray<CommandCenterMemoryEntry>;
  readonly total: number;
  readonly projectTitle: (id: ProjectId | null) => string | null;
  /** New todos join the focused project, if any. */
  readonly focusProjectId: ProjectId | null;
  readonly onOpenTodos: () => void;
}) {
  const { canOperate } = useCommandCenter();
  const { setMemoryDone, upsert } = useCommandCenterCommands();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const add = async () => {
    const text = draft.trim();
    if (!text || saving) return;
    setSaving(true);
    const result = await upsert({
      entity: "memory",
      value: {
        projectId: focusProjectId,
        sectionId: null,
        threadId: null,
        kind: "todo",
        text,
        done: false,
        source: "user",
      },
    });
    setSaving(false);
    if (result._tag === "Success") setDraft("");
  };
  return (
    <HomeBlock
      title={total > 0 ? `Todos (${total})` : "Todos"}
      action={
        total > 0 ? (
          <Button size="xs" variant="ghost" onClick={onOpenTodos}>
            Open in Memory
          </Button>
        ) : null
      }
    >
      {todos.length > 0 ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {todos.map((todo) => (
            <li key={todo.id}>
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={false}
                  disabled={!canOperate}
                  aria-label={`Mark "${todo.text}" done`}
                  onCheckedChange={(checked) => {
                    if (checked) void setMemoryDone({ id: todo.id, done: true });
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2">{todo.text}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[projectTitle(todo.projectId), formatRelativeTimeLabel(todo.createdAt)]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          <EmptyDescription>No open todos</EmptyDescription>
        </Empty>
      )}
      {canOperate ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Input
            size="sm"
            aria-label="Add todo"
            placeholder="Add todo"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="outline"
            aria-label="Add todo"
            disabled={saving || !draft.trim()}
          >
            <PlusIcon />
          </Button>
        </form>
      ) : null}
    </HomeBlock>
  );
}
