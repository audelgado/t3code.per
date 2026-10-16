import type { HomeView, NeedsYouItem, TaskItem, TaskStatus } from "../../server/types.ts";

/** Alerts stay visible even when actionable items span several pages. */
export function homeAttention(items: NeedsYouItem[]) {
  return {
    alerts: items.filter((n) => n.kind === "alert"),
    actions: items.filter((n) => n.kind !== "alert"),
  };
}

/** Resolve sheets against the complete loaded snapshot, independently of pagination. */
export function homeThread(view: HomeView, key: string | null) {
  return [...view.needsYou.flatMap((n) => n.kind === "thread" ? [n.thread] : []), ...view.running, ...view.done].find((t) => t.key === key);
}

export function matchesSearch(query: string, ...fields: (string | null | undefined)[]) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

export const queueGroups = ["Pending approval", "Ongoing", "Queued", "Recent failed / cancelled", "Completed"] as const;
export function queueGroup(status: TaskStatus): typeof queueGroups[number] {
  switch (status) {
    case "pending_approval": return "Pending approval";
    case "queued": return "Queued";
    case "failed":
    case "cancelled": return "Recent failed / cancelled";
    case "done": return "Completed";
    default: return "Ongoing";
  }
}

/** Group for scanning, preserving the server's dispatch order within each group. */
export function queueResults(tasks: TaskItem[], query: string, machine: string, status: string) {
  const filtered = tasks.filter((t) => (!machine || t.machineId === machine) && (!status || t.status === status) && matchesSearch(query, t.title, t.prompt, t.machineLabel, t.projectTitle));
  return queueGroups.flatMap((group) => filtered.filter((t) => queueGroup(t.status) === group));
}
