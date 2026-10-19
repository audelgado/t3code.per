import type { HomeView } from "../../server/types.ts";

/** A changed SSE frame from another project must not reload this transcript. */
export function projectChatRevision(view: HomeView | null, machine: string, project: string) {
  if (!view) return "";
  const threads = [...view.running, ...view.done, ...view.needsYou.flatMap((n) => n.kind === "thread" ? [n.thread] : [])]
    .filter((t) => t.machineId === machine && t.projectId === project)
    .map((t) => [t.threadId, t.status, t.updatedAt, t.pending?.id ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([view.machines.find((m) => m.id === machine)?.link.status, threads]);
}
