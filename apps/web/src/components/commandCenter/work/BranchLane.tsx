import { AuthOrchestrationOperateScope, type VcsStatusResult } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useEnvironmentScope } from "~/state/session";
import { useState } from "react";
import { Button } from "../../ui/button";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection } from "../collectionPaging";
import { BranchCard } from "./BranchCard";
import type { WorkLane } from "./workView";
import { statusKey } from "./workView";
import type { WorkItem } from "./workItems";
import type { CloseProgress } from "./useWorkActions";
export function BranchLane({
  lane,
  collapsed,
  onCollapse,
  compact,
  reorder,
  onMove,
  onNew,
  focused,
  onFocus,
  statuses,
  allowed,
  onLoad,
  machine,
  connected,
  progress,
  onProgress,
}: {
  readonly lane: WorkLane;
  readonly collapsed: boolean;
  readonly onCollapse: () => void;
  readonly compact: boolean;
  readonly reorder: boolean;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onNew: () => void;
  readonly focused: string | undefined;
  readonly onFocus: (key: string) => void;
  readonly statuses: ReadonlyMap<string, VcsStatusResult>;
  readonly allowed: ReadonlySet<string>;
  readonly onLoad: (item: WorkItem) => void;
  readonly machine: string;
  readonly connected: boolean;
  readonly progress: ReadonlyMap<string, CloseProgress>;
  readonly onProgress: (progress: CloseProgress) => void;
}) {
  const canLaunch = useEnvironmentScope(lane.project.environmentId, AuthOrchestrationOperateScope);
  const rootStatus = statuses.get(
    JSON.stringify([lane.project.environmentId, lane.project.workspaceRoot]),
  );
  const [page, setPage] = useState(1);
  const paged = paginateCollection(lane.items, page, 8);
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${lane.project.title}`}
          aria-expanded={!collapsed}
          onClick={onCollapse}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {lane.project.title}{" "}
          <span className="text-xs font-normal text-muted-foreground">
            {lane.items.length} branches - {machine}
          </span>
        </h2>
        {reorder && (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${lane.project.title} up`}
              onClick={() => onMove(-1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Move ${lane.project.title} down`}
              onClick={() => onMove(1)}
            >
              <ArrowDownIcon />
            </Button>
          </>
        )}
        <Button size="xs" variant="ghost" disabled={!connected || !canLaunch} onClick={onNew}>
          New work
        </Button>
      </div>
      {!collapsed && (
        <div className="ml-3 space-y-2 border-l border-border pl-3">
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <svg
              aria-hidden="true"
              width="20"
              height="16"
              viewBox="0 0 20 16"
              className="shrink-0 text-muted-foreground"
            >
              <path d="M3 0v8q0 5 5 5h12" fill="none" stroke="currentColor" />
              <circle cx="3" cy="5" r="2" fill="currentColor" />
            </svg>
            <span className="font-mono">{rootStatus?.refName ?? "Project checkout"}</span>
            {rootStatus?.hasWorkingTreeChanges ? (
              <span className="text-warning-foreground">
                {rootStatus.workingTree.files.length} uncommitted
              </span>
            ) : (
              <span>{rootStatus ? "Clean" : "Status not loaded"}</span>
            )}
          </div>
          {paged.items.map((item) => (
            <BranchCard
              key={item.key}
              item={item}
              status={allowed.has(statusKey(item)) ? (statuses.get(statusKey(item)) ?? null) : null}
              compact={compact}
              focused={focused === item.key}
              machine={machine}
              connected={connected}
              onFocus={() => onFocus(item.key)}
              onLoad={() => onLoad(item)}
              progress={progress.get(item.key)}
              onProgress={onProgress}
            />
          ))}
          {paged.pageCount > 1 && (
            <CollectionPager {...paged} label="branches" onPageChange={setPage} />
          )}
        </div>
      )}
    </section>
  );
}
