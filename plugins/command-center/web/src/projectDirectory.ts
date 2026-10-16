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
