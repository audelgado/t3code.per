import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useEnvironmentScope, readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { threadEnvironment } from "~/state/threads";
import { vcsEnvironment, vcsActionManager } from "~/state/vcs";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { buildThreadRouteParams } from "~/threadRoutes";
import { randomUUID } from "~/lib/utils";
import { usableWorkStatus } from "./workView";
import { closeBlocker, type WorkItem } from "./workItems";

import { changeWorkLifecycle, type CloseProgress } from "./workLifecycle";
export type { CloseProgress } from "./workLifecycle";
export function pullRequestReference(item: WorkItem, status: VcsStatusResult | null) {
  const pr = status?.pr ?? item.pr;
  if (!pr) return null;
  try {
    const url = new URL(pr.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[2] !== "pull") return null;
    return {
      projectId: item.projectId,
      host: url.host,
      repository: `${parts[0]}/${parts[1]}`,
      number: pr.number,
    };
  } catch {
    return null;
  }
}
/** Every completed step is retained so a later failure can be repaired with Reopen. */
export function useWorkActions(
  item: WorkItem,
  observedStatus: VcsStatusResult | null,
  progress: CloseProgress | undefined,
  onProgress: (progress: CloseProgress) => void,
  connected: boolean,
) {
  const status = usableWorkStatus(item, observedStatus);
  const navigate = useNavigate();
  const canOperate = useEnvironmentScope(item.environmentId, AuthOrchestrationOperateScope);
  const canPush = useEnvironmentScope(item.environmentId, AuthSourceControlWriteScope);
  const canRemove = useAtomValue(vcsEnvironment.removeWorktree.permissionAtom(item.environmentId));
  const canCreate = useAtomValue(vcsEnvironment.createWorktree.permissionAtom(item.environmentId));
  const canUpdate = useAtomValue(
    pullRequestEnvironment.runAction.permissionAtom(item.environmentId),
  );
  const archive = useOrchestrationCommand(threadEnvironment.archive);
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive);
  const remove = useAtomCommand(vcsEnvironment.removeWorktree);
  const create = useAtomCommand(vcsEnvironment.createWorktree);
  const push = useAtomCommand(
    vcsActionManager.runStackedAction({ environmentId: item.environmentId, cwd: item.cwd }),
  );
  const update = useAtomCommand(pullRequestEnvironment.runAction);
  const sync = useAtomCommand(vcsEnvironment.refreshStatus);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocker = closeBlocker(item, status);
  const open = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(item.environmentId, item.latestThreadId)),
    });
  const run = async (task: () => Promise<void>) => {
    if (busy || !connected) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const check = <A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Success") throw new Error(String(squashAtomCommandFailure(result)));
  };
  const commands = {
    remove: async () => {
      if (item.worktreePath)
        check(
          await remove({
            environmentId: item.environmentId,
            input: { cwd: item.project.workspaceRoot, path: item.worktreePath },
          }),
        );
    },
    create: async () => {
      if (item.worktreePath)
        check(
          await create({
            environmentId: item.environmentId,
            input: {
              cwd: item.project.workspaceRoot,
              refName: item.branch,
              path: item.worktreePath,
            },
          }),
        );
    },
    archive: async (threadId: WorkItem["threadIds"][number]) => {
      check(await archive({ environmentId: item.environmentId, input: { threadId } }));
    },
    unarchive: async (threadId: WorkItem["threadIds"][number]) => {
      check(await unarchive({ environmentId: item.environmentId, input: { threadId } }));
    },
  };
  const close = () =>
    run(async () => {
      if (blocker || !canOperate || (item.worktreePath && !canRemove)) return;
      await changeWorkLifecycle(
        "close",
        progress ?? { item, archived: [], removed: false, closed: false, error: null },
        commands,
        onProgress,
      );
    });
  const reopen = () =>
    run(async () => {
      if (!progress || !canOperate || (progress.removed && !canCreate)) return;
      await changeWorkLifecycle("reopen", progress, commands, onProgress);
    });
  const reference = pullRequestReference(item, status);
  return {
    busy,
    error: error ?? progress?.error,
    canClose: connected && canOperate && (!item.worktreePath || canRemove) && blocker === null,
    canReopen: connected && canOperate && (!progress?.removed || canCreate),
    canPush:
      connected &&
      canPush &&
      status !== null &&
      status.hasPrimaryRemote &&
      !status.hasWorkingTreeChanges,
    canUpdate:
      connected &&
      status !== null &&
      canUpdate &&
      reference !== null &&
      status.pr?.state === "open",
    blocker: !connected
      ? "Machine offline"
      : !canOperate
        ? "Thread changes are not allowed"
        : item.worktreePath && !canRemove
          ? "Worktree changes are not allowed"
          : blocker,
    open,
    close,
    reopen,
    push: () =>
      run(async () => {
        if (
          !readEnvironmentScope(item.environmentId, AuthSourceControlWriteScope) ||
          !status ||
          !status.hasPrimaryRemote ||
          status.hasWorkingTreeChanges
        )
          return;
        check(
          await push({ actionId: randomUUID(), action: "push", threadId: item.latestThreadId }),
        );
      }),
    update: () =>
      run(async () => {
        if (reference && status && status.pr?.state === "open" && canUpdate)
          check(
            await update({
              environmentId: item.environmentId,
              input: { ...reference, action: "update-branch" },
            }),
          );
      }),
    sync: () =>
      run(async () => {
        check(await sync({ environmentId: item.environmentId, input: { cwd: item.cwd } }));
      }),
  };
}
