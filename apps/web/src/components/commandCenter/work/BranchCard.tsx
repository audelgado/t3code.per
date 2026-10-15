import type { VcsStatusResult } from "@t3tools/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { StatusDot } from "../StatusDot";
import { WorkStepper } from "./WorkStepper";
import { workStage, type WorkItem } from "./workItems";
import { usableWorkStatus } from "./workView";
import { useWorkActions, type CloseProgress } from "./useWorkActions";
import { useNavigate } from "@tanstack/react-router";
import { openQuickActionLink } from "../customization";
import { formatRelativeTimeLabel } from "~/timestampFormat";
export function BranchCard({
  item,
  status: observedStatus,
  compact = false,
  focused = false,
  machine,
  connected,
  onFocus,
  onLoad,
  progress,
  onProgress,
  quickActions = false,
}: {
  readonly item: WorkItem;
  readonly status: VcsStatusResult | null;
  readonly compact?: boolean;
  readonly focused?: boolean;
  readonly machine: string;
  readonly connected: boolean;
  readonly onFocus: () => void;
  readonly onLoad: () => void;
  readonly progress: CloseProgress | undefined;
  readonly onProgress: (progress: CloseProgress) => void;
  readonly quickActions?: boolean;
}) {
  const status = usableWorkStatus(item, observedStatus);
  const actions = useWorkActions(item, status, progress, onProgress, connected);
  const [confirm, setConfirm] = useState<"close" | "push" | "update" | null>(null);
  const stage = workStage(item, status);
  const pr = status?.pr ?? item.pr;
  const navigate = useNavigate();
  const repositoryUrl = item.project.repositoryIdentity?.webUrl;
  const githubUrl =
    pr?.url ??
    (repositoryUrl
      ? `${repositoryUrl.replace(/\/$/, "")}/tree/${encodeURIComponent(item.branch)}`
      : null);
  const openGithub = () => {
    if (githubUrl) void openQuickActionLink(githubUrl, navigate);
  };
  const repairing = progress?.removed || (progress?.archived.length ?? 0) > 0 || progress?.closed;
  const primary = repairing
    ? "Reopen"
    : !status
      ? "Load status"
      : status.aheadCount > 0 || (!status.hasUpstream && (status.aheadOfDefaultCount ?? 0) > 0)
        ? "Push"
        : "Open";
  const runPrimary = () =>
    primary === "Reopen"
      ? void actions.reopen()
      : primary === "Load status"
        ? onLoad()
        : primary === "Push"
          ? setConfirm("push")
          : actions.open();
  const primaryDisabled =
    actions.busy ||
    (primary === "Reopen" ? !actions.canReopen : primary === "Push" ? !actions.canPush : false);
  return (
    <article
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-card/40",
        compact ? "px-3 py-2" : "space-y-3 p-3",
        focused && "border-primary/60",
      )}
      aria-label={`${item.project.title}: ${item.branch}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onFocus}
          className="min-w-0 flex-1 truncate text-left font-mono text-xs outline-none focus-visible:underline"
          aria-label={item.branch}
        >
          {item.branch}
        </button>
        <StatusDot
          tone={
            !connected
              ? "muted"
              : item.agent === "needs-you"
                ? "warning"
                : item.agent === "working"
                  ? "info"
                  : "muted"
          }
          label={
            !connected ? "Offline" : progress?.closed ? "Closed" : item.agent.replace("-", " ")
          }
        />
        {compact && <WorkStepper {...stage} compact />}
        <Button size="xs" variant="outline" disabled={primaryDisabled} onClick={runPrimary}>
          {primary}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost" aria-label={`Actions for ${item.branch}`} />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={actions.open}>Open thread</MenuItem>
            <MenuItem
              disabled={!actions.canPush || actions.busy || !status || status.hasWorkingTreeChanges}
              onClick={() => setConfirm("push")}
            >
              Push commits
            </MenuItem>
            <MenuItem
              disabled={!actions.canUpdate || actions.busy}
              title="Open a PR first, or merge main from the thread"
              onClick={() => setConfirm("update")}
            >
              Update from main
            </MenuItem>
            <MenuItem disabled={!githubUrl} onClick={openGithub}>
              Open on GitHub
            </MenuItem>
            <MenuItem disabled={!connected || actions.busy} onClick={() => void actions.sync()}>
              Sync
            </MenuItem>
            <MenuItem
              disabled={!actions.canClose || actions.busy || !!repairing}
              title={actions.blocker ?? undefined}
              onClick={() => setConfirm("close")}
            >
              Close work
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {!compact && (
        <>
          <WorkStepper {...stage} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{machine}</span>
            <span>{formatRelativeTimeLabel(item.updatedAt)}</span>
            {status ? (
              <>
                <span>
                  Ahead {status.aheadCount} / behind {status.behindCount} upstream
                </span>
                {status.hasWorkingTreeChanges && (
                  <span className="text-warning-foreground">
                    {status.workingTree.files.length} uncommitted
                  </span>
                )}
              </>
            ) : (
              <span>Status not loaded</span>
            )}
            <span>
              {pr
                ? `PR #${pr.number} - ${pr.state ?? "linked"}`
                : status && !status.hasPrimaryRemote
                  ? "No remote"
                  : "No PR"}
            </span>
            {actions.blocker && !repairing && <span>{actions.blocker}</span>}
          </div>
        </>
      )}
      {quickActions ? (
        <div className="grid grid-cols-2 gap-2">
          <Button size="sm" variant="outline" onClick={actions.open}>
            Open thread
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!actions.canPush || actions.busy}
            title={
              !actions.canPush
                ? "Load this branch's clean checkout on a connected machine with source control permission."
                : undefined
            }
            onClick={() => setConfirm("push")}
          >
            Push
          </Button>
          <Button size="sm" variant="outline" disabled={!githubUrl} onClick={openGithub}>
            GitHub
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!actions.canClose || actions.busy || !!repairing}
            title={actions.blocker ?? undefined}
            onClick={() => setConfirm("close")}
          >
            Close
          </Button>
        </div>
      ) : null}
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2 text-xs">
          <span>
            {confirm === "close"
              ? `Archive ${item.threadIds.length} thread(s)${item.worktreePath ? " and remove this clean worktree" : ""}?`
              : confirm === "push"
                ? `Push ${item.branch} from ${machine}?`
                : `Merge the default branch into PR #${pr?.number ?? ""} on GitHub?`}
          </span>
          <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            size="xs"
            variant={confirm === "close" ? "destructive" : "default"}
            disabled={
              actions.busy ||
              (confirm === "close"
                ? !actions.canClose
                : confirm === "push"
                  ? !actions.canPush
                  : !actions.canUpdate)
            }
            onClick={() => {
              setConfirm(null);
              void (confirm === "close"
                ? actions.close()
                : confirm === "push"
                  ? actions.push()
                  : actions.update());
            }}
          >
            {confirm === "close" ? "Close" : confirm === "push" ? "Push" : "Update"}
          </Button>
        </div>
      )}
      {actions.error && (
        <p role="alert" className="mt-2 break-words text-xs text-destructive-foreground">
          {actions.error}
          {repairing ? " - Reopen repairs completed steps." : ""}
        </p>
      )}
    </article>
  );
}
