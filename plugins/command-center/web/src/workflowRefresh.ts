import type { HomeView } from "../../server/types.ts";

/** Only task/thread changes can advance steps; alerts and assistant messages cannot. */
export function workflowSignal(view: HomeView | null, scope?: { machineId: string; projectId: string; id: string }) {
  if (!view) return "";
  const relevant = (item: { machineId: string; projectId: string }) => !scope || item.machineId === scope.machineId && item.projectId === scope.projectId;
  return JSON.stringify([
    view.queue.filter(relevant).map((t) => [t.id, t.status, t.updatedAt]),
    [...view.running, ...view.done].filter(relevant).map((t) => [t.key, t.status, t.updatedAt, t.pending, t.planReady]),
    view.needsYou.flatMap((n) => n.kind === "workflow" ? !scope || n.runId === scope.id ? [[n.key, n.since, n.text]] : [] : n.kind === "thread" && relevant(n.thread) ? [[n.thread.key, n.since, n.reason]] : n.kind === "task_approval" && relevant(n.task) ? [[n.task.id, n.task.updatedAt]] : []),
  ]);
}

/** Some workflow edits emit a view without a workflow signal. Keep an event-driven fallback. */
export function createWorkflowRefresh(intervalMs = 15_000) {
  let previous: string | undefined;
  let last = -Infinity;
  return (signal: string, now = Date.now()) => {
    if (signal === previous && now - last < intervalMs) return false;
    previous = signal;
    last = now;
    return true;
  };
}
