import {
  COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT,
  type CommandCenterWorkflowRun,
  type CommandCenterWorkflowRunsState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { CollectionPager } from "../CollectionPager";
import { paginateCollection, showLoadOlder } from "../collectionPaging";
import {
  keepRunsLeavingFeed,
  oldestWorkflowRun,
  orderWorkflowRuns,
  RUN_STATUS_LABEL,
  statusVariant,
} from "./workflowLogic";

const RUN_PAGE = 10;
const OLDER_PAGE = 50;

/**
 * Runs from a live feed, waiting ones first, ten per page. The feed holds the newest runs;
 * "Load older runs", on the last page, pages in the rest from the same server.
 */
export function WorkflowRunList({
  environmentId,
  projectId,
  live,
  projectTitle,
  onOpenRun,
}: {
  readonly environmentId: EnvironmentId;
  /** The project whose runs `live` holds; omitted for every project's. */
  readonly projectId?: ProjectId;
  readonly live: CommandCenterWorkflowRunsState | null;
  /** Names each run's project when the list spans projects. */
  readonly projectTitle?: (projectId: ProjectId) => string;
  readonly onOpenRun: (run: CommandCenterWorkflowRun) => void;
}) {
  const listRuns = useAtomCommand(
    serverEnvironment.listCommandCenterWorkflowRuns,
    "load older workflow runs",
  );
  const [older, setOlder] = useState<ReadonlyArray<CommandCenterWorkflowRun>>([]);
  // Unknown until the first older page: a full feed may have more behind it.
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  // A new run pushes the feed's oldest out; it stays listed, ahead of the older pages.
  const [previousLive, setPreviousLive] = useState(live);
  if (live !== previousLive) {
    setPreviousLive(live);
    if (previousLive !== null && live !== null) {
      setOlder((current) => keepRunsLeavingFeed(previousLive.runs, live.runs, current));
    }
  }
  const runs = useMemo(() => orderWorkflowRuns(live?.runs ?? [], older), [live, older]);
  const paged = paginateCollection(runs, page, RUN_PAGE);
  const more = hasMore ?? (live?.runs.length ?? 0) >= COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT;

  const loadOlder = async () => {
    // Server pages are contiguous, so the last older row continues exactly where they stopped.
    const before = older.at(-1) ?? oldestWorkflowRun(live?.runs ?? []);
    if (loading || before === undefined) return;
    setLoading(true);
    const result = await listRuns({
      environmentId,
      input: { before: before.id, limit: OLDER_PAGE, ...(projectId ? { projectId } : {}) },
    });
    setLoading(false);
    if (result._tag !== "Success") return;
    setOlder((current) => [...current, ...result.value.runs]);
    setHasMore(result.value.hasMore);
  };

  if (live === null) {
    return <p className="text-sm text-muted-foreground">Loading runs…</p>;
  }
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No runs yet. Run a workflow to follow its progress here.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-xl border">
        {paged.items.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onOpenRun(run)}
              className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-start text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <Badge size="sm" variant={statusVariant(run.status)}>
                {RUN_STATUS_LABEL[run.status]}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                {run.title}
                {projectTitle ? (
                  <span className="text-muted-foreground"> · {projectTitle(run.projectId)}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatRelativeTimeLabel(run.startedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <CollectionPager {...paged} label="runs" onPageChange={setPage}>
        {showLoadOlder(paged, more) ? (
          <Button size="xs" variant="outline" disabled={loading} onClick={() => void loadOlder()}>
            {loading ? "Loading…" : "Load older runs"}
          </Button>
        ) : null}
      </CollectionPager>
    </div>
  );
}
