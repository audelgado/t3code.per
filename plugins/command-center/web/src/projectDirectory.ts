import type { MachineProjects } from "../../server/types.ts";
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
    { id: "pinned", title: "Pinned", groupId: null, items: sort(entries.filter((e) => pinned.has(e.key))) },
    ...settings.groups.map((g) => ({ id: g.id, title: g.name, groupId: g.id, items: sort(entries.filter((e) => !pinned.has(e.key) && inGroup(e) === g.id)) })),
    { id: "other", title: settings.groups.length ? "Other" : "Projects", groupId: null, items: sort(entries.filter((e) => !pinned.has(e.key) && inGroup(e) === null)) },
  ];
  const query = filters.query.trim().toLowerCase();
  const matches = (e: ProjectEntry) => (!filters.machineId || e.machine.machineId === filters.machineId)
    && (filters.status === "all" || (filters.status === "online" ? e.machine.status === "online" : e.machine.status !== "online"))
    && (!query || `${e.title} ${e.path}`.toLowerCase().includes(query));
  // Retain full bucket indices: moving across a page/filter boundary still moves one original neighbor.
  const rows = buckets.flatMap((bucket) => bucket.items.flatMap((entry, index) => matches(entry) ? [{ bucket, entry, index }] : []));
  const pagination = paginateCollection(rows, page, size);
  return { pagination, buckets: buckets.flatMap((bucket) => {
    const rows = pagination.items.filter((row) => row.bucket === bucket);
    return rows.length ? [{ ...bucket, rows }] : [];
  }), inGroup };
}
