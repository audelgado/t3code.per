import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { FileDiffIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { randomUUID } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { vcsEnvironment } from "~/state/vcs";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatWorktreePathForDisplay } from "~/worktreeCleanup";
import { resolveQuickAction } from "../../GitActionsControl.logic";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
import { toastManager } from "../../ui/toast";

/**
 * The way back from a delegated step's worktree, through the same flows as the thread view:
 * the Changes panel, the Git quick action (commit, push, open a PR), and deleting the thread
 * with its worktree. Mount it only for a thread that has a worktree; it watches that
 * worktree's Git status while mounted.
 */
export function AgentWorktree({
  shell,
  worktreePath,
  onDiscarded,
}: {
  readonly shell: EnvironmentThreadShell;
  readonly worktreePath: string;
  /** Runs once the thread (and, if the user agreed, its worktree) is deleted. */
  readonly onDiscarded: () => Promise<unknown>;
}) {
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => scopeThreadRef(shell.environmentId, shell.id),
    [shell.environmentId, shell.id],
  );
  const scope = useMemo(
    () => ({ environmentId: shell.environmentId, cwd: worktreePath }),
    [shell.environmentId, worktreePath],
  );
  const status = useEnvironmentQuery(
    vcsEnvironment.status({ environmentId: scope.environmentId, input: { cwd: scope.cwd } }),
  );
  const gitAction = useGitStackedAction(scope);
  const { confirmAndDeleteThread } = useThreadActions();
  const openPrLink = useOpenPrLink(threadRef);
  const [discarding, setDiscarding] = useState(false);
  const quick = resolveQuickAction(
    status.data,
    gitAction.isPending,
    status.data?.isDefaultRef ?? false,
    status.data?.hasPrimaryRemote ?? false,
  );
  const canRunQuick = quick.kind === "run_action" && quick.action !== undefined && !quick.disabled;
  // Publishing a repo and pulling need the thread view's Git dialogs, so those go there.
  const needsThread =
    (quick.kind === "open_publish" || quick.kind === "run_pull") && !quick.disabled;

  const openThread = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  const openDiff = () => {
    useRightPanelStore.getState().open(threadRef, "diff");
    openThread();
  };

  const apply = async () => {
    if (quick.kind !== "run_action" || quick.action === undefined) return;
    const result = await gitAction.run({
      actionId: randomUUID(),
      action: quick.action,
      threadId: shell.id,
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Action failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    const { toast } = result.value;
    const cta = toast.cta;
    toastManager.add({
      type: "success",
      title: toast.title,
      description: toast.description,
      ...(cta.kind === "open_pr"
        ? { actionProps: { children: cta.label, onClick: (event) => openPrLink(event, cta.url) } }
        : {}),
    });
  };

  const discard = async () => {
    setDiscarding(true);
    const result = await confirmAndDeleteThread(threadRef);
    // A declined confirm also succeeds, so only release once the thread is really gone.
    if (result._tag === "Success" && result.value !== undefined) await onDiscarded();
    setDiscarding(false);
  };

  return (
    <div className="space-y-1.5">
      <Label>Worktree</Label>
      <p className="truncate text-xs text-muted-foreground">
        {shell.branch ?? "Preparing branch"} · {formatWorktreePathForDisplay(worktreePath)}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={openDiff}>
          <FileDiffIcon />
          Open diff
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={needsThread ? false : !canRunQuick || !gitAction.isAllowed}
          title={quick.hint}
          onClick={() => (needsThread ? openThread() : void apply())}
        >
          <PullRequestGlyph.pullRequest />
          {quick.label}
        </Button>
        <Button
          size="sm"
          variant="ghost-destructive"
          disabled={discarding}
          onClick={() => void discard()}
        >
          <Trash2Icon />
          Discard
        </Button>
      </div>
      {needsThread ? (
        <p className="text-xs text-muted-foreground">
          {quick.label} opens the thread; finish it from its Git menu.
        </p>
      ) : quick.hint && !canRunQuick ? (
        <p className="text-xs text-muted-foreground">{quick.hint}</p>
      ) : null}
    </div>
  );
}
