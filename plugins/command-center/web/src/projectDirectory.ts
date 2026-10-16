import type { HomeView, MachineProjects, TaskItem, ThreadItem } from "../../server/types.ts";
import { compareManual, type ProjectSettings, type ProjectSort } from "../../server/settings.ts";
import { paginateCollection } from "./pagination.ts";

export interface ProjectEntry {
  key: string;
  machine: MachineProjects;
  title: string;
  path: string;
  running: number;
  needs: number;
  queued: number;
  /** Newest thread activity (ISO) or the project's own update time. */
  active: string;
}

export interface ProjectFilters {
  query: string;
  machineId: string;
  status: "all" | "online" | "offline";
}

/** "<machineId>:<projectId>" -> its parts. Sections, memory and artifacts store only the T3 projectId. */
export function splitProjectKey(key: string) {
  const i = key.indexOf(":");
  return { machineId: key.slice(0, i), projectId: key.slice(i + 1) };
}

/** One entry per project and machine, with the live counts the cards show. */
export function projectEntries(machines: MachineProjects[], view: HomeView | null): ProjectEntry[] {
  type Stat = { running: number; needs: number; queued: number; active: string };
  const stat = new Map<string, Stat>();
  const bump = (key: string, f: (s: Stat) => void) => {
    const s = stat.get(key) ?? { running: 0, needs: 0, queued: 0, active: "" };
    f(s);
    stat.set(key, s);
  };
  const seen = (s: Stat, iso: string) => (s.active = iso > s.active ? iso : s.active);
  for (const t of view?.running ?? []) bump(`${t.machineId}:${t.projectId}`, (s) => (s.running++, seen(s, t.updatedAt)));
  for (const t of view?.done ?? []) bump(`${t.machineId}:${t.projectId}`, (s) => seen(s, t.updatedAt));
  for (const n of view?.needsYou ?? []) {
    const o = n.kind === "thread" ? n.thread : n.kind === "task_approval" ? n.task : null;
    if (o) bump(`${o.machineId}:${o.projectId}`, (s) => s.needs++);
  }
  for (const t of view?.queue ?? []) if (t.status === "queued") bump(`${t.machineId}:${t.projectId}`, (s) => s.queued++);
  return machines.flatMap((m) =>
    m.projects.map((p) => {
      const key = `${m.machineId}:${p.id}`;
      const s = stat.get(key);
      return { key, machine: m, title: p.title, path: p.workspaceRoot, running: s?.running ?? 0, needs: s?.needs ?? 0, queued: s?.queued ?? 0, active: s?.active || p.updatedAt };
    }),
  );
}

/** What the live view holds for one project: actionable items first, then today's finished threads. */
export function projectWork(view: HomeView | null, key: string) {
  const { machineId, projectId } = splitProjectKey(key);
  const mine = (o: { machineId: string; projectId: string }) => o.machineId === machineId && o.projectId === projectId;
  const needs = (view?.needsYou ?? []).flatMap((n) => (n.kind === "thread" && mine(n.thread)) || (n.kind === "task_approval" && mine(n.task)) ? [n] : []);
  const running: ThreadItem[] = (view?.running ?? []).filter(mine);
  const queued: TaskItem[] = (view?.queue ?? []).filter((t) => t.status === "queued" && mine(t));
  const done: ThreadItem[] = (view?.done ?? []).filter(mine);
  return { needs, running, queued, done, open: needs.length + running.length + queued.length };
}

export function projectDirectory(entries: ProjectEntry[], settings: ProjectSettings, filters: ProjectFilters, page: number, size: number) {
  const manual = compareManual(settings.order);
  const by: Record<ProjectSort, (a: ProjectEntry, b: ProjectEntry) => number> = {
    activity: (a, b) => b.active.localeCompare(a.active),
    attention: (a, b) => b.needs - a.needs || b.running - a.running || b.active.localeCompare(a.active),
    name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    manual: (a, b) => manual(a.key, b.key),
  };
  const sort = (items: ProjectEntry[]) => items.toSorted((a, b) => by[settings.sort](a, b) || a.title.localeCompare(b.title));
  const pinned = new Set(settings.pinned);
  const groupIds = new Set(settings.groups.map((g) => g.id));
  const inGroup = (e: ProjectEntry) => groupIds.has(settings.groupOf[e.key] ?? "") ? settings.groupOf[e.key]! : null;
  const buckets = [
    { id: "pinned", title: "Fijados", groupId: null, items: sort(entries.filter((e) => pinned.has(e.key))) },
    ...settings.groups.map((g) => ({ id: g.id, title: g.name, groupId: g.id, items: sort(entries.filter((e) => !pinned.has(e.key) && inGroup(e) === g.id)) })),
    { id: "other", title: settings.groups.length ? "Otros" : "Proyectos", groupId: null, items: sort(entries.filter((e) => !pinned.has(e.key) && inGroup(e) === null)) },
  ];
  const query = filters.query.trim().toLowerCase();
  const matches = (e: ProjectEntry) => (!filters.machineId || e.machine.machineId === filters.machineId)
    && (filters.status === "all" || (filters.status === "online" ? e.machine.status === "online" : e.machine.status !== "online"))
    && (!query || `${e.title} ${e.path}`.toLowerCase().includes(query));
  const collapsed = new Set(settings.collapsed);
  // Retain full bucket indices for manual moves across unfiltered page boundaries.
  const matchingBuckets = buckets.map((bucket) => ({
    ...bucket,
    collapsed: bucket.groupId !== null && collapsed.has(bucket.groupId),
    matchingRows: bucket.items.flatMap((entry, index) => matches(entry) ? [{ entry, index }] : []),
  }));
  const rows = matchingBuckets.flatMap((bucket) => bucket.collapsed ? [] : bucket.matchingRows.map((row) => ({ bucket, ...row })));
  const pagination = paginateCollection(rows, page, size);
  return {
    pagination,
    matchingTotal: matchingBuckets.reduce((total, bucket) => total + bucket.matchingRows.length, 0),
    canMove: settings.sort === "manual" && !query && !filters.machineId && filters.status === "all",
    // Headers stay reachable even when their rows are collapsed or on another page.
    buckets: matchingBuckets.filter((bucket) => bucket.groupId !== null || bucket.items.length > 0).map((bucket) => ({
      ...bucket,
      matchingCount: bucket.matchingRows.length,
      rows: pagination.items.filter((row) => row.bucket === bucket),
    })),
    inGroup,
  };
}
