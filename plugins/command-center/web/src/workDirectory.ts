// Pure model of Trabajo: CC tasks and T3 branches as one list of entries, grouped by what you do with them.
// A task and the branch its thread works on are one entry (WorkRow.taskId); branches without a CC task stand alone.
import type { LinkStatus, TaskItem, ThreadItem } from "../../server/types.ts";
import type { WorkMachine, WorkRow } from "../../server/work.ts";
import { FAILED_RECENT_MS, matchesSearch, REASON_ACTION, threadReason, threadWhy } from "./homeQueueView.ts";
import { at, priorityLabel, type Tone } from "./look.ts";
import { paginateCollection } from "./pagination.ts";

/** Where an entry sits, in display order. `idle` and `done` are history: the only paged groups. */
export type Bucket = "need" | "pr" | "run" | "queue" | "idle" | "done";
export const BUCKETS: readonly Bucket[] = ["need", "pr", "run", "queue", "idle", "done"];
export const BUCKET_LABEL: Record<Bucket, string> = { need: "Te necesita", pr: "PR abierto", run: "En marcha", queue: "En cola", idle: "Sin agente", done: "Listo" };
export const BUCKET_TONE: Record<Bucket, Tone> = { need: "need", pr: "pr", run: "run", queue: "queue", idle: "queue", done: "ok" };
export const isHistory = (b: Bucket) => b === "idle" || b === "done";

export interface WorkEntry {
  /** "task:<id>" or "branch:<WorkRow.key>". */
  key: string;
  title: string;
  machineId: string;
  machineLabel: string;
  machineStatus: LinkStatus;
  projectId: string;
  /** "<machineId>:<projectId>". */
  projectKey: string;
  projectTitle: string;
  bucket: Bucket;
  task: TaskItem | null;
  row: WorkRow | null;
  /** The live thread behind it, when the view still lists it: what the approval overlay opens. */
  thread: ThreadItem | null;
  /** Titles of the tasks it waits for. */
  blockedBy: string[];
  updatedAt: string;
}

export interface MachineInfo {
  id: string;
  label: string;
  status: LinkStatus;
}

export function taskBucket(t: Pick<TaskItem, "status" | "finishedAt" | "updatedAt">, row: WorkRow | null, now: number): Bucket {
  switch (t.status) {
    case "pending_approval":
    case "needs_you":
      return "need";
    case "failed":
      return now - Date.parse(t.finishedAt ?? t.updatedAt) < FAILED_RECENT_MS ? "need" : "done";
    case "queued":
      return "queue";
    case "starting":
    case "running":
    case "waiting":
      return "run";
    case "done":
      return row?.pr?.state === "open" ? "pr" : "done";
    case "cancelled":
      return "done";
  }
}

export function rowBucket(row: WorkRow): Bucket {
  if (row.agent === "needs-you") return "need";
  if (row.agent === "working") return "run";
  if (row.pr?.state === "open") return "pr";
  return row.tidy ? "done" : "idle";
}

interface Inputs {
  queue: TaskItem[];
  work: WorkMachine[];
  machines: MachineInfo[];
  threads: ThreadItem[];
  now?: number;
}

/** Tasks first (the server's dispatch order), then lone branches; groups by bucket, history newest first. */
export function buildWork({ queue, work, machines, threads, now = Date.now() }: Inputs): WorkEntry[] {
  const machineOf = new Map(machines.map((m) => [m.id, m]));
  const threadByKey = new Map(threads.map((t) => [t.key, t]));
  const threadByUrl = new Map(threads.map((t) => [t.appUrl, t]));
  const titles = new Map(queue.map((t) => [t.id, t.title]));
  const rowOfTask = new Map<string, WorkRow>();
  for (const m of work) for (const lane of m.lanes) for (const r of lane.rows) if (r.taskId && !rowOfTask.has(r.taskId)) rowOfTask.set(r.taskId, r);
  const status = (id: string): LinkStatus => machineOf.get(id)?.status ?? "offline";

  const entries: WorkEntry[] = queue.map((t) => {
    const row = rowOfTask.get(t.id) ?? null;
    return {
      key: `task:${t.id}`, title: t.title, machineId: t.machineId, machineLabel: t.machineLabel, machineStatus: status(t.machineId),
      projectId: t.projectId, projectKey: `${t.machineId}:${t.projectId}`, projectTitle: t.projectTitle, bucket: taskBucket(t, row, now),
      task: t, row, thread: (t.threadId && threadByKey.get(`${t.machineId}:${t.threadId}`)) || (row && threadByUrl.get(row.appUrl)) || null,
      blockedBy: t.blockedBy.map((id) => titles.get(id) ?? id), updatedAt: t.finishedAt ?? t.updatedAt,
    };
  });
  for (const m of work)
    for (const lane of m.lanes)
      for (const row of lane.rows) {
        if (row.taskId && titles.has(row.taskId)) continue;
        entries.push({
          key: `branch:${row.key}`, title: row.title, machineId: m.id, machineLabel: m.label, machineStatus: status(m.id), projectId: lane.projectId,
          projectKey: `${m.id}:${lane.projectId}`, projectTitle: lane.title, bucket: rowBucket(row), task: null, row, thread: threadByUrl.get(row.appUrl) ?? null,
          blockedBy: [], updatedAt: row.updatedAt,
        });
      }
  // Array.sort is stable: queue and need keep the server's order; the rest is newest first.
  const rank = (b: Bucket) => BUCKETS.indexOf(b);
  return entries.sort((a, b) => rank(a.bucket) - rank(b.bucket) || (a.bucket === "need" || a.bucket === "queue" ? 0 : b.updatedAt.localeCompare(a.updatedAt)));
}

// ---- filters ----

export type WorkTab = "all" | "need" | "run" | "queue" | "done";
export const WORK_TABS: readonly (readonly [WorkTab, string])[] = [["all", "Todos"], ["need", "Te necesita"], ["run", "En marcha"], ["queue", "En cola"], ["done", "Listo"]];
const TAB_BUCKETS: Record<WorkTab, readonly Bucket[] | null> = { all: null, need: ["need"], run: ["run", "pr"], queue: ["queue"], done: ["done"] };

export interface WorkFilters {
  tab: WorkTab;
  query: string;
  /** "" = every project / machine. */
  projectKey: string;
  machineId: string;
}
export const NO_FILTERS: WorkFilters = { tab: "all", query: "", projectKey: "", machineId: "" };

const matches = (e: WorkEntry, f: WorkFilters) =>
  (!f.projectKey || e.projectKey === f.projectKey) &&
  (!f.machineId || e.machineId === f.machineId) &&
  matchesSearch(f.query, e.title, e.task?.prompt, e.projectTitle, e.machineLabel, e.row?.branch);

/** Entries after search, project and machine (not the tab), so tab counts follow the other filters. */
export const searchWork = (entries: WorkEntry[], f: WorkFilters) => entries.filter((e) => matches(e, f));

export const tabCounts = (found: WorkEntry[]): Record<WorkTab, number> => ({
  all: found.length,
  need: found.filter((e) => e.bucket === "need").length,
  run: found.filter((e) => e.bucket === "run" || e.bucket === "pr").length,
  queue: found.filter((e) => e.bucket === "queue").length,
  done: found.filter((e) => e.bucket === "done").length,
});

/** Actionable groups are returned whole; only history is paged. */
export function workPage(found: WorkEntry[], tab: WorkTab, page: number, size = 8) {
  const allowed = TAB_BUCKETS[tab];
  const shown = allowed ? found.filter((e) => allowed.includes(e.bucket)) : found;
  return {
    actionable: BUCKETS.filter((b) => !isHistory(b)).map((bucket) => ({ bucket, items: shown.filter((e) => e.bucket === bucket) })).filter((g) => g.items.length),
    history: paginateCollection(shown.filter((e) => isHistory(e.bucket)), page, size),
  };
}

/** Consecutive entries of one bucket, in order. */
export function groupByBucket(items: WorkEntry[]): { bucket: Bucket; items: WorkEntry[] }[] {
  const out: { bucket: Bucket; items: WorkEntry[] }[] = [];
  for (const e of items) {
    const last = out.at(-1);
    if (last?.bucket === e.bucket) last.items.push(e);
    else out.push({ bucket: e.bucket, items: [e] });
  }
  return out;
}

/** Projects with merged or stale branches an agent can tidy. */
export function tidyLanes(work: WorkMachine[]) {
  return work.flatMap((m) =>
    m.lanes.flatMap((lane) => {
      const count = lane.rows.filter((r) => r.tidy).length;
      return count ? [{ machineId: m.id, machineLabel: m.label, projectId: lane.projectId, projectKey: `${m.id}:${lane.projectId}`, title: lane.title, count }] : [];
    }),
  );
}

// ---- what an entry shows ----

/** Colour of its stepper ring and its status line. */
export function entryTone(e: Pick<WorkEntry, "bucket" | "task">): Tone {
  return e.task?.status === "failed" ? "fail" : BUCKET_TONE[e.bucket];
}

/** Primary action of an entry: opens the overlay or the detail, retries, or links to the PR. */
export type EntryAction = { label: string; kind: "thread" | "detail" | "retry" | "pr"; href?: string };
export function entryAction(e: WorkEntry): EntryAction | null {
  const t = e.task;
  if (t?.status === "pending_approval") return { label: "Aprobar", kind: "detail" };
  if (t?.status === "failed" && e.bucket === "need") return { label: "Reintentar", kind: "retry" };
  if (e.bucket === "need" && e.thread) {
    const reason = threadReason(e.thread);
    if (reason) return { label: REASON_ACTION[reason], kind: "thread" };
  }
  if (e.bucket === "need") return { label: "Abrir", kind: "detail" };
  if (e.bucket === "pr" && e.row?.pr) return { label: "Ver PR", kind: "pr", href: e.row.pr.url };
  return null;
}

/** One line on what the entry is doing or waiting for; "" when there is nothing to add. */
export function entryWhy(e: WorkEntry): string {
  const t = e.task;
  const r = e.row;
  if (t?.status === "pending_approval") return `${t.source === "user" ? "Vos" : t.source.slice(6)} quiere encolar esta tarea`;
  if (t?.status === "failed") return t.error?.split("\n").find((l) => l.trim())?.trim() ?? "Falló";
  if (e.bucket === "need" && e.thread) {
    const why = threadWhy(e.thread);
    if (why) return why;
  }
  if (t?.status === "waiting") return t.limitResetAt ? `Esperando el límite de uso hasta ${at(t.limitResetAt)}` : "Esperando";
  if (t?.status === "queued") {
    if (t.queueReason) return t.queueReason;
    if (e.blockedBy.length) return `Espera a ${e.blockedBy.join(", ")}`;
    if (e.machineStatus !== "online") return `Esperando a ${e.machineLabel}`;
    return t.priority !== 0 ? `Prioridad ${priorityLabel(t.priority).toLowerCase()}` : "";
  }
  if (r?.blocked) return r.blocked;
  if (r?.note) return r.note;
  if (r?.pr) return `PR #${r.pr.number}${r.pr.isDraft && r.pr.state === "open" ? " (borrador)" : ""}`;
  return "";
}
