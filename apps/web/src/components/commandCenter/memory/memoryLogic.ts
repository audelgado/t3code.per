import type {
  CommandCenterMemoryEntry,
  CommandCenterMemoryKind,
  ProjectId,
} from "@t3tools/contracts";
import { paginateCollection } from "../collectionPaging";

/** Project filter: everything, entries with no project, or one project. */
export type MemoryProjectFilter = "all" | "none" | ProjectId;

export interface MemoryFilter {
  readonly project: MemoryProjectFilter;
  readonly kind: CommandCenterMemoryKind | "all";
  readonly search: string;
}

export interface MemoryDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly entries: ReadonlyArray<CommandCenterMemoryEntry>;
}

/** Bounds the rendered timeline, retaining chronological day labels across page boundaries. */
export function selectMemoryPage(days: ReadonlyArray<MemoryDay>, page: number) {
  const entries = days.flatMap((day) => day.entries.map((entry) => ({ day: day.day, entry })));
  const directory = paginateCollection(entries, page, 25);
  const visible: { day: string; entries: CommandCenterMemoryEntry[] }[] = [];
  for (const item of directory.items) {
    const last = visible.at(-1);
    if (last?.day === item.day) last.entries.push(item.entry);
    else visible.push({ day: item.day, entries: [item.entry] });
  }
  return { ...directory, days: visible };
}

function localDay(iso: string) {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Filters entries and groups them by local day, newest day and newest entry first. */
export function groupMemoryByDay(
  entries: ReadonlyArray<CommandCenterMemoryEntry>,
  filter: MemoryFilter,
): ReadonlyArray<MemoryDay> {
  const needle = filter.search.trim().toLowerCase();
  const days = new Map<string, CommandCenterMemoryEntry[]>();
  const matching = entries
    .filter(
      (entry) =>
        (filter.project === "all" ||
          (filter.project === "none"
            ? entry.projectId === null
            : entry.projectId === filter.project)) &&
        (filter.kind === "all" || entry.kind === filter.kind) &&
        (needle === "" || entry.text.toLowerCase().includes(needle)),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const entry of matching) {
    const day = localDay(entry.createdAt);
    const list = days.get(day);
    if (list) list.push(entry);
    else days.set(day, [entry]);
  }
  return [...days].map(([day, dayEntries]) => ({ day, entries: dayEntries }));
}

/** Snapshot entries plus older pages, deduped by id. The snapshot copy wins since it is live. */
export function mergeMemoryPages(
  snapshot: ReadonlyArray<CommandCenterMemoryEntry>,
  older: ReadonlyArray<CommandCenterMemoryEntry>,
): ReadonlyArray<CommandCenterMemoryEntry> {
  if (older.length === 0) return snapshot;
  const seen = new Set(snapshot.map((entry) => entry.id));
  return [...snapshot, ...older.filter((entry) => !seen.has(entry.id))];
}

/**
 * Cursor for the next `listMemory` page: the last loaded older entry, else the oldest
 * snapshot entry among the newest-100 window. Todos are skipped, done or not: the snapshot
 * keeps open ones regardless of age, and one closed since keeps its old date, so paging from
 * either would jump past unseen entries. `beforeCreatedAt` keeps paging working if the cursor
 * entry is deleted meanwhile.
 */
export function nextMemoryCursor(
  snapshot: ReadonlyArray<CommandCenterMemoryEntry>,
  older: ReadonlyArray<CommandCenterMemoryEntry>,
):
  | { readonly before: CommandCenterMemoryEntry["id"]; readonly beforeCreatedAt: string }
  | undefined {
  let cursor = older.at(-1);
  if (!cursor) {
    for (const entry of snapshot) {
      if (entry.kind === "todo") continue;
      if (!cursor || entry.createdAt < cursor.createdAt) cursor = entry;
    }
  }
  return cursor ? { before: cursor.id, beforeCreatedAt: cursor.createdAt } : undefined;
}
