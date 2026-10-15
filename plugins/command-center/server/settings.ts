// Projects-board settings, stored as one JSON value in kv. Pure helpers plus load/save; no runtime
// imports, so the web bundle can use compareManual/moveProject without pulling in node:sqlite.
import type { DatabaseSync } from "node:sqlite";

export type ProjectSort = "activity" | "name" | "attention" | "manual";
const SORTS: readonly ProjectSort[] = ["activity", "name", "attention", "manual"];
export const MAX_GROUPS = 50;
export const MAX_PROJECTS = 200;
export const SETTINGS_KEY = "settings.projects";

declare module "./types.ts" {
  interface Api {
    "GET /api/settings/projects": { body: never; res: ProjectSettings };
    "PUT /api/settings/projects": { body: ProjectSettings; res: ProjectSettings };
  }
}

export interface ProjectSettings {
  /** Project keys ("<machineId>:<projectId>"), shown first. */
  pinned: string[];
  groups: { id: string; name: string }[];
  /** project key -> group id; a project without an entry is ungrouped. */
  groupOf: Record<string, string>;
  /** Manual order as project keys; unknown projects sort last. */
  order: string[];
  /** Collapsed group ids. */
  collapsed: string[];
  sort: ProjectSort;
  /** Keys this build does not know, kept so another client's settings round-trip. */
  [unknown: string]: unknown;
}

const KNOWN = new Set(["pinned", "groups", "groupOf", "order", "collapsed", "sort", "projects", "projectGroups", "projectOrder"]);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" && v.trim().length <= max ? v.trim() : null);
const strings = (v: unknown, max: number) => [...new Set(Array.isArray(v) ? v.flatMap((s) => text(s, max) ?? []) : [])].slice(0, MAX_PROJECTS);

/**
 * Validates untrusted input into settings. Also reads the old Command Center shape
 * (projects[{key,pinned,groupId}], projectGroups, projectOrder), so those objects import as-is.
 */
export function normalizeSettings(raw: unknown): ProjectSettings {
  const r = isObj(raw) ? raw : {};
  const ids = new Set<string>();
  const rawGroups: unknown[] = Array.isArray(r.groups) ? r.groups : Array.isArray(r.projectGroups) ? r.projectGroups : [];
  const groups = rawGroups
    .flatMap((g) => {
      const id = isObj(g) ? text(g.id, 80) : null;
      const name = isObj(g) ? text(g.name, 40) : null;
      if (!id || !name || ids.has(id)) return [];
      ids.add(id);
      return [{ id, name }];
    })
    .slice(0, MAX_GROUPS);
  const groupIds = new Set(groups.map((g) => g.id));

  const pinned = strings(r.pinned, 500);
  const groupOf: Record<string, string> = {};
  const assign = (key: string | null, gid: string | null) => {
    if (key && gid && groupIds.has(gid) && Object.keys(groupOf).length < MAX_PROJECTS) groupOf[key] = gid;
  };
  if (isObj(r.groupOf)) for (const [k, g] of Object.entries(r.groupOf)) assign(text(k, 500), text(g, 80));
  for (const p of Array.isArray(r.projects) ? r.projects : []) {
    if (!isObj(p)) continue;
    const key = text(p.key, 500);
    if (key && p.pinned === true && pinned.length < MAX_PROJECTS && !pinned.includes(key)) pinned.push(key);
    assign(key, text(p.groupId, 80));
  }

  const out: ProjectSettings = {
    pinned,
    groups,
    groupOf,
    order: strings(r.order ?? r.projectOrder, 500),
    collapsed: strings(r.collapsed, 80).filter((id) => groupIds.has(id)),
    sort: SORTS.includes(r.sort as ProjectSort) ? (r.sort as ProjectSort) : "activity",
  };
  for (const [k, v] of Object.entries(r)) if (!KNOWN.has(k)) out[k] = v;
  return out;
}

export function loadSettings(db: DatabaseSync): ProjectSettings {
  const row = db.prepare("select v from kv where k = ?").get(SETTINGS_KEY);
  return normalizeSettings(row ? JSON.parse(row.v as string) : {});
}

/** Validates, stores and returns the settings (what the caller should show back). */
export function saveSettings(db: DatabaseSync, input: unknown): ProjectSettings {
  const next = normalizeSettings(input);
  db.prepare("insert into kv(k, v) values (?, ?) on conflict(k) do update set v = excluded.v").run(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** Unknown projects retain their input order after the explicitly ordered ones. */
export function compareManual(order: readonly string[]) {
  const pos = new Map<string, number>();
  order.forEach((key, i) => pos.has(key) || pos.set(key, i));
  return (a: string, b: string) => (pos.get(a) ?? order.length) - (pos.get(b) ?? order.length);
}

/** Swaps `key` with its visible neighbour, keeping the saved positions of projects hidden from the list. */
export function moveProject(order: readonly string[], listedKeys: readonly string[], key: string, direction: -1 | 1) {
  const listed = new Set(listedKeys);
  const result = [...new Set([...order, ...listedKeys])];
  const visible = result.filter((k) => listed.has(k));
  const i = visible.indexOf(key);
  const neighbor = visible[i + direction];
  if (i >= 0 && neighbor !== undefined) {
    const at = result.indexOf(key);
    result[result.indexOf(neighbor)] = key;
    result[at] = neighbor;
  }
  return result.slice(0, MAX_PROJECTS);
}
