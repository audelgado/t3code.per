import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { VcsStatusResult } from "@t3tools/contracts";
import { useState } from "react";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../ui/empty";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { useCommandCenter, useCommandCenterEnvironments } from "../shared";
import type { WorkItem } from "./workItems";
import { statusKey, type WorkLane } from "./workView";
import {
  TIDY_GROUPS,
  TIDY_LABELS,
  canRemoveTidyWorktree,
  inventoryEntries,
  tidyCommand,
  type TidyEntry,
  type TidyGroup,
} from "./tidyLogic";
import { useBranchHealth } from "./useBranchHealth";
function TidyRow({
  entry,
  onLoad,
  removed,
  onRemoved,
}: {
  readonly entry: TidyEntry;
  readonly onLoad: (item: WorkItem) => void;
  readonly removed: boolean;
  readonly onRemoved: (entry: TidyEntry, removed: boolean) => void;
}) {
  const { openPlan } = useCommandCenter();
  const machines = useCommandCenterEnvironments();
  const connected = machines.some(
    (machine) => machine.environmentId === entry.project.environmentId && machine.connected,
  );
  const permitted = useAtomValue(
    vcsEnvironment.removeWorktree.permissionAtom(entry.project.environmentId),
  );
  const restorePermitted = useAtomValue(
    vcsEnvironment.createWorktree.permissionAtom(entry.project.environmentId),
  );
  const remove = useAtomCommand(vcsEnvironment.removeWorktree);
  const create = useAtomCommand(vcsEnvironment.createWorktree);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = () =>
    openPlan({
      projectId: entry.project.id,
      steps: [
        {
          text: `Review branch ${entry.branch} in ${entry.project.workspaceRoot}. Inspect git status and remote/PR state before proposing cleanup. Preserve all uncommitted or unpushed work; ask before deleting branches or removing worktrees.`,
        },
      ],
    });
  const change = async () => {
    if (busy || !connected || !entry.worktreePath) return;
    setBusy(true);
    setError(null);
    try {
      const result = removed
        ? await create({
            environmentId: entry.project.environmentId,
            input: {
              cwd: entry.project.workspaceRoot,
              refName: entry.branch,
              path: entry.worktreePath,
            },
          })
        : await remove({
            environmentId: entry.project.environmentId,
            input: { cwd: entry.project.workspaceRoot, path: entry.worktreePath },
          });
      if (result._tag === "Success") {
        onRemoved(entry, !removed);
        setConfirm(false);
      } else setError(String(squashAtomCommandFailure(result)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-b border-border/60 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" aria-label={entry.branch}>
          {entry.branch}
        </span>
        <span className="text-xs text-muted-foreground">
          {entry.project.title} ·{" "}
          {machines.find((machine) => machine.environmentId === entry.project.environmentId)
            ?.label ?? "Offline"}
        </span>
        {removed ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!connected || !restorePermitted || busy}
            onClick={() => void change()}
          >
            Restore worktree
          </Button>
        ) : (
          <Button size="xs" variant="outline" disabled={!connected} onClick={ask}>
            Ask an agent to tidy
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              .writeText(tidyCommand(entry))
              .catch((cause) => setError(String(cause)))
          }
        >
          Copy command
        </Button>
        {!removed && canRemoveTidyWorktree(entry) && (
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={!permitted || !connected || busy}
            title={!permitted ? "Source control changes are not allowed" : undefined}
            onClick={() => setConfirm(true)}
          >
            Remove worktree
          </Button>
        )}
        {!entry.status && entry.item && (
          <Button
            size="xs"
            variant="ghost"
            disabled={!connected}
            onClick={() => {
              if (entry.item) onLoad(entry.item);
            }}
          >
            Load status
          </Button>
        )}
      </div>
      {confirm && !removed && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>Remove this clean worktree? Branch and threads stay.</span>
          <Button size="xs" variant="ghost" onClick={() => setConfirm(false)}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={!permitted || !connected || busy || !canRemoveTidyWorktree(entry)}
            onClick={() => void change()}
          >
            Remove
          </Button>
        </div>
      )}
      {removed && (
        <p className="text-xs text-muted-foreground">
          Worktree removed. Restore is available for this session.
        </p>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
export function TidyBranches({
  lanes,
  statuses,
  allowed,
  onLoad,
}: {
  readonly lanes: readonly WorkLane[];
  readonly statuses: ReadonlyMap<string, VcsStatusResult>;
  readonly allowed: ReadonlySet<string>;
  readonly onLoad: (item: WorkItem) => void;
}) {
  const machines = useCommandCenterEnvironments();
  const health = useBranchHealth(
    lanes.filter((lane) =>
      machines.some(
        (machine) => machine.environmentId === lane.project.environmentId && machine.connected,
      ),
    ),
  );
  const [group, setGroup] = useState<TidyGroup>("merged");
  const [page, setPage] = useState(1);
  const [removedEntries, setRemovedEntries] = useState<ReadonlyMap<string, TidyEntry>>(
    () => new Map(),
  );
  const scannedEntries = lanes.flatMap((lane) =>
    inventoryEntries(
      lane.project,
      health.refs.get(lane.key)?.refs ?? [],
      lane.items,
      (item) => (allowed.has(statusKey(item)) ? (statuses.get(statusKey(item)) ?? null) : null),
      health.merged.get(lane.key) ?? new Set(),
    ),
  );
  const mergedEntries = new Map(scannedEntries.map((entry) => [entry.key, entry]));
  for (const entry of removedEntries.values()) mergedEntries.set(entry.key, entry);
  const entries = [...mergedEntries.values()];
  const onRemoved = (entry: TidyEntry, removed: boolean) =>
    setRemovedEntries((previous) => {
      const next = new Map(previous);
      if (removed) next.set(entry.key, entry);
      else next.delete(entry.key);
      return next;
    });
  const paged = paginateCollection(
    entries.filter((entry) => entry.group === group),
    page,
    5,
  );
  return (
    <section className="space-y-3 border-t border-border/60 pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-medium">
          Tidy branches <span className="text-muted-foreground">{entries.length}</span>
        </h2>
        <Button
          size="xs"
          variant="outline"
          disabled={health.busy}
          onClick={() => void health.scan()}
        >
          {health.busy ? "Scanning…" : "Scan page projects"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Never removes uncommitted work. Branch deletion stays with your agent. Status covers loaded
        worktrees; divergence is against upstream.
      </p>
      <div role="tablist" aria-label="Branch hygiene" className="flex flex-wrap gap-1">
        {TIDY_GROUPS.map((value) => (
          <Button
            key={value}
            size="xs"
            variant={value === group ? "secondary" : "ghost"}
            role="tab"
            aria-selected={value === group}
            onClick={() => {
              setGroup(value);
              setPage(1);
            }}
          >
            {TIDY_LABELS[value]} {entries.filter((entry) => entry.group === value).length}
          </Button>
        ))}
      </div>
      {health.error && (
        <p role="alert" className="break-words text-xs text-destructive-foreground">
          {health.error}
        </p>
      )}
      {paged.items.length ? (
        <>
          <div>
            {paged.items.map((entry) => (
              <TidyRow
                key={entry.key}
                entry={entry}
                onLoad={onLoad}
                removed={removedEntries.has(entry.key)}
                onRemoved={onRemoved}
              />
            ))}
          </div>
          <CollectionPager {...paged} label="branches" onPageChange={setPage} />
        </>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing to tidy here</EmptyTitle>
            <EmptyDescription>
              Scan these projects to look for merged PR branches and load worktree status to inspect
              local changes.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {lanes.some(
        (lane) => health.refs.get(lane.key)?.nextCursor !== null && health.refs.has(lane.key),
      ) && (
        <p className="text-xs text-muted-foreground">Showing the first 100 branches per project.</p>
      )}
    </section>
  );
}
