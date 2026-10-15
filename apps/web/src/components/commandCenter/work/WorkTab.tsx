import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { useThreadShells } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useRelativeTimeTick } from "../../settings/settingsLayout";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { CollectionPager } from "../CollectionPager";
import {
  WORK_SORT_KEY,
  WORK_COLLAPSED_KEY,
  WORK_DENSITY_KEY,
  moveProject,
  type ProjectSort,
} from "../projectOrder";
import { useCommandCenter, useCommandCenterEnvironments } from "../shared";
import { BranchLane } from "./BranchLane";
import { BranchCard } from "./BranchCard";
import { WorkRotator } from "./WorkRotator";
import { TidyBranches } from "./TidyBranches";
import { WorkStatusObserver } from "./useWorkStatuses";
import type { CloseProgress } from "./useWorkActions";
import { deriveWorkItems, type WorkItem } from "./workItems";
import {
  filterByMachine,
  orderLanes,
  pageLanes,
  chooseStatusItems,
  statusKey,
  nextIndex,
  prevIndex,
  isWorkTypingTarget,
  usableWorkStatus,
} from "./workView";

const collapsedSchema = Schema.Array(Schema.String);
const densitySchema = Schema.Literals(["comfortable", "compact"]);
const sortSchema = Schema.Literals(["activity", "name", "attention", "manual"]);
/** Work owns only the visible page's subscriptions; closing this tab releases them. */
export function WorkTab({ quickSwitch = false }: { readonly quickSwitch?: boolean }) {
  const { projects, projectId, primaryEnvironmentId } = useCommandCenter();
  const shells = useThreadShells();
  const machines = useCommandCenterEnvironments();
  const [machine, setMachine] = useState<EnvironmentId | "all">("all");
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [requestedKey, setRequestedKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [reorder, setReorder] = useState(false);
  const [progress, setProgress] = useState<ReadonlyMap<string, CloseProgress>>(() => new Map());
  const [statuses, setStatuses] = useState<ReadonlyMap<string, VcsStatusResult>>(() => new Map());
  const [collapsed, setCollapsed] = useLocalStorage<readonly string[], readonly string[]>(
    WORK_COLLAPSED_KEY,
    [],
    collapsedSchema,
  );
  const [density, setDensity] = useLocalStorage(WORK_DENSITY_KEY, "comfortable", densitySchema);
  const [sort, setSort] = useLocalStorage<ProjectSort, ProjectSort>(
    WORK_SORT_KEY,
    "activity",
    sortSchema,
  );
  const manual = usePrimarySettings((settings) => settings.commandCenter.projectOrder);
  const updateSettings = useUpdatePrimarySettings();
  const canOrder = useEnvironmentScope(primaryEnvironmentId, AuthSettingsWriteScope);
  const newThread = useNewThreadHandler();
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const refresh = useAtomCommand(vcsEnvironment.refreshStatus);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [syncError, setSyncError] = useState(false);
  useRelativeTimeTick(60_000);
  const items = useMemo(() => {
    const derived = deriveWorkItems(shells, projects);
    const byKey = new Map(derived.map((item) => [item.key, item]));
    for (const entry of progress.values())
      if (entry.closed || entry.removed || entry.archived.length)
        byKey.set(entry.item.key, entry.item);
    return filterByMachine([...byKey.values()], machine).filter(
      (item) => !projectId || item.projectId === projectId,
    );
  }, [shells, projects, progress, machine, projectId]);
  const focused = items.find((item) => item.key === focusedKey) ?? items[0];
  const launchProject =
    focused?.project ?? projects.find((project) => !projectId || project.id === projectId);
  const canLaunch = useEnvironmentScope(
    launchProject?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const lanes = useMemo(() => orderLanes(items, sort, manual), [items, sort, manual]);
  const paged = pageLanes(lanes, page);
  const selected = chooseStatusItems(
    focused,
    quickSwitch
      ? []
      : paged.items.map((lane) => ({
          ...lane,
          items: [{ ...lane.items[0]!, cwd: lane.project.workspaceRoot }, ...lane.items],
        })),
    collapsed,
    items.find((item) => item.key === requestedKey),
  );
  const online = selected.filter(
    (item) =>
      machines.some(
        (machine) => machine.environmentId === item.environmentId && machine.connected,
      ) && !progress.get(item.key)?.removed,
  );
  const allowed = new Set(online.map(statusKey));
  const observed = items.flatMap((item) => {
    const status = allowed.has(statusKey(item))
      ? usableWorkStatus(item, statuses.get(statusKey(item)) ?? null)
      : null;
    return status ? [{ item, status }] : [];
  });
  const counters = [
    { label: "Active work", count: items.filter((item) => !progress.get(item.key)?.closed).length },
    {
      label: "Needs sync",
      count: observed.filter(({ status }) => status.aheadCount > 0 || status.behindCount > 0)
        .length,
    },
    {
      label: "Open PRs",
      count: items.filter(
        (item) =>
          (usableWorkStatus(item, statuses.get(statusKey(item)) ?? null)?.pr ?? item.pr)?.state ===
          "open",
      ).length,
    },
    {
      label: "To tidy",
      count: observed.filter(
        ({ item, status }) =>
          status.hasWorkingTreeChanges ||
          !status.hasPrimaryRemote ||
          status.aheadCount > 0 ||
          status.behindCount > 0 ||
          (status.pr ?? item.pr)?.state === "merged",
      ).length,
    },
  ];
  const syncPage = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError(false);
    try {
      let failed = false;
      if (focused && online.some((item) => statusKey(item) === statusKey(focused))) {
        const result = await refresh({
          environmentId: focused.environmentId,
          input: { cwd: focused.cwd },
        });
        failed = result._tag !== "Success";
      }
      for (const lane of paged.items) {
        if (
          !machines.some(
            (machine) => machine.environmentId === lane.project.environmentId && machine.connected,
          )
        )
          continue;
        const result = await executeAtomQuery(
          registry,
          vcsEnvironment.listRefs({
            environmentId: lane.project.environmentId,
            input: { cwd: lane.project.workspaceRoot, refKind: "local", limit: 100 },
          }),
          { refresh: true, reportFailure: true },
        );
        if (result._tag !== "Success") failed = true;
      }
      setSyncError(failed);
      if (!failed) setSyncedAt(new Date().toISOString());
    } finally {
      setSyncing(false);
    }
  };
  const recordStatus = useCallback((key: string, status: VcsStatusResult | null) => {
    setStatuses((previous) => {
      if (previous.get(key) === status || (!status && !previous.has(key))) return previous;
      const next = new Map(previous);
      if (status) next.set(key, status);
      else next.delete(key);
      return next;
    });
  }, []);
  const recordProgress = useCallback(
    (entry: CloseProgress) =>
      setProgress((previous) => new Map(previous).set(entry.item.key, entry)),
    [],
  );
  const open = useCallback(
    (item: WorkItem) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(item.environmentId, item.latestThreadId)),
      }),
    [navigate],
  );
  const launch = (item: WorkItem | undefined) => {
    const project = item?.project ?? launchProject;
    if (project)
      void newThread(scopeProjectRef(project.environmentId, project.id), { envMode: "worktree" });
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isWorkTypingTarget(event.target) ||
        document.querySelector('[role="dialog"], [aria-modal="true"], [data-slot="menu-popup"]')
      )
        return;
      const index = items.findIndex((item) => item.key === focused?.key);
      const strip =
        event.target instanceof HTMLElement && event.target.closest('[aria-label="Active work"]');
      if (
        event.key === "[" ||
        event.key === "]" ||
        (strip && (event.key === "ArrowLeft" || event.key === "ArrowRight"))
      ) {
        event.preventDefault();
        const next =
          event.key === "[" || event.key === "ArrowLeft"
            ? prevIndex(index, items.length)
            : nextIndex(index, items.length);
        setFocusedKey(items[next]?.key ?? null);
      } else if (
        event.key === "Enter" &&
        focused &&
        !(event.target instanceof HTMLElement && event.target.closest("button,a"))
      ) {
        event.preventDefault();
        open(focused);
      } else if (event.key === "w" && focused && canLaunch) {
        event.preventDefault();
        void newThread(scopeProjectRef(focused.environmentId, focused.projectId), {
          envMode: "worktree",
        });
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [focused, items, newThread, open, canLaunch]);
  const label = (item: WorkItem) =>
    machines.find((machine) => machine.environmentId === item.environmentId)?.label ?? "Offline";
  const connected = (item: WorkItem) =>
    machines.some((machine) => machine.environmentId === item.environmentId && machine.connected);
  const load = (item: WorkItem) => {
    setRequestedKey(item.key);
    setFocusedKey(item.key);
  };
  const move = (key: string, direction: -1 | 1) => {
    if (canOrder)
      void updateSettings({
        commandCenter: {
          projectOrder: moveProject(
            manual,
            lanes.map((lane) => lane.key),
            key,
            direction,
          ),
        },
      });
  };
  return (
    <div className="min-w-0 space-y-5">
      {online.map((item) => (
        <WorkStatusObserver
          key={statusKey(item)}
          item={item}
          focused={focused !== undefined && statusKey(focused) === statusKey(item)}
          onStatus={recordStatus}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">
          Work <span className="text-muted-foreground">{items.length}</span>
        </h2>
        <Select<EnvironmentId | "all">
          value={machine}
          onValueChange={(value) => {
            if (value) setMachine(value);
            setPage(1);
          }}
        >
          <SelectTrigger size="sm" aria-label="Filter work by machine">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All machines</SelectItem>
            {machines.map((machine) => (
              <SelectItem
                key={machine.environmentId}
                value={machine.environmentId}
                disabled={!machine.connected}
              >
                {machine.label}
                {machine.connected ? "" : " - offline"}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          disabled={syncing || !online.length}
          onClick={() => void syncPage()}
        >
          {syncing ? "Syncing…" : "Sync"}
        </Button>
        <Button
          size="xs"
          disabled={
            !launchProject ||
            !canLaunch ||
            !machines.some(
              (machine) =>
                machine.environmentId === launchProject.environmentId && machine.connected,
            )
          }
          onClick={() => launch(focused)}
        >
          New work
        </Button>
      </div>
      {!quickSwitch ? (
        <>
          <div className="grid grid-cols-2 divide-x divide-y rounded-xl border border-border/60 bg-card/40 sm:grid-cols-4 sm:divide-y-0">
            {counters.map((counter) => (
              <div key={counter.label} className="min-w-0 space-y-2 p-3">
                <p className="truncate text-xs text-muted-foreground">{counter.label}</p>
                <p className="text-2xl tabular-nums">{counter.count}</p>
                <div className="h-1 rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-1 rounded-full bg-primary"
                    style={{
                      width: `${items.length ? Math.min(100, (counter.count / items.length) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground" role="status">
            {syncError
              ? "Some projects could not sync. Try again."
              : syncedAt
                ? `Synced ${formatRelativeTimeLabel(syncedAt)}`
                : `${observed.length} checkouts loaded; sync and tidy counts cover loaded status.`}
          </p>
        </>
      ) : null}
      {!items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No active work</EmptyTitle>
            <EmptyDescription>
              {machines.some((machine) => machine.connected)
                ? "Open a thread on a branch to track its progress here."
                : "Connect a machine to see its work."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : quickSwitch && focused ? (
        <>
          <div className="flex justify-between gap-2">
            <Button
              size="sm"
              variant="outline"
              aria-label="Previous work"
              onClick={() =>
                setFocusedKey(items[prevIndex(items.indexOf(focused), items.length)]?.key ?? null)
              }
            >
              Previous
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              {items.indexOf(focused) + 1} of {items.length}
            </span>
            <Button
              size="sm"
              variant="outline"
              aria-label="Next work"
              onClick={() =>
                setFocusedKey(items[nextIndex(items.indexOf(focused), items.length)]?.key ?? null)
              }
            >
              Next
            </Button>
          </div>
          <p className="text-sm font-medium">{focused.project.title}</p>
          <p className="line-clamp-2 break-words text-xs text-muted-foreground">
            {
              shells.find(
                (shell) =>
                  shell.environmentId === focused.environmentId &&
                  shell.id === focused.latestThreadId,
              )?.source.latestVisibleMessage?.text
            }
          </p>
          <BranchCard
            quickActions
            item={focused}
            status={
              allowed.has(statusKey(focused)) ? (statuses.get(statusKey(focused)) ?? null) : null
            }
            focused
            machine={label(focused)}
            connected={connected(focused)}
            onFocus={() => {}}
            onLoad={() => load(focused)}
            progress={progress.get(focused.key)}
            onProgress={recordProgress}
          />
          <div className="divide-y divide-border">
            {items.slice(0, 8).map((item) => (
              <button
                type="button"
                key={item.key}
                onClick={() => setFocusedKey(item.key)}
                className="flex w-full min-w-0 items-center gap-2 py-3 text-left text-xs"
              >
                <span className="truncate">{item.project.title}</span>
                <span className="ml-auto truncate font-mono text-muted-foreground">
                  {item.branch}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <WorkRotator
            items={items}
            focused={focused}
            onFocus={setFocusedKey}
            onOpen={open}
            machineLabel={label}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={sort}
              onValueChange={(value) => {
                if (value) setSort(value);
                setPage(1);
              }}
            >
              <SelectTrigger size="sm" aria-label="Sort work projects">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="activity">Activity</SelectItem>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="attention">Needs attention</SelectItem>
                <SelectItem value="manual">Manual</SelectItem>
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setCollapsed(lanes.map((lane) => lane.key))}
            >
              Collapse all
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setCollapsed([])}>
              Expand all
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-pressed={density === "compact"}
              onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
            >
              Compact
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canOrder}
              aria-pressed={reorder}
              onClick={() => {
                setReorder(!reorder);
                setSort("manual");
              }}
            >
              Reorder
            </Button>
          </div>
          {paged.items.map((lane) => (
            <BranchLane
              key={lane.key}
              lane={lane}
              collapsed={collapsed.includes(lane.key)}
              onCollapse={() =>
                setCollapsed((previous) =>
                  previous.includes(lane.key)
                    ? previous.filter((key) => key !== lane.key)
                    : [...previous, lane.key],
                )
              }
              compact={density === "compact"}
              reorder={reorder}
              onMove={(direction) => move(lane.key, direction)}
              onNew={() => launch(lane.items[0])}
              focused={focused?.key}
              onFocus={setFocusedKey}
              statuses={statuses}
              allowed={allowed}
              onLoad={load}
              machine={label(lane.items[0]!)}
              connected={connected(lane.items[0]!)}
              progress={progress}
              onProgress={recordProgress}
            />
          ))}
          <CollectionPager {...paged} label="projects" onPageChange={setPage} />
          <TidyBranches lanes={paged.items} statuses={statuses} allowed={allowed} onLoad={load} />
        </>
      )}
    </div>
  );
}
