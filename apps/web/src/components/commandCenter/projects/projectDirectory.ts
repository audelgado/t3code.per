import {
  parseScopedProjectKey,
  scopedProjectKey,
  scopeProjectRef,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  getThreadSortTimestamp,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";
import type { CommandCenterSection, ProjectId } from "@t3tools/contracts";

import { compareManual } from "../projectOrder";
import type { CommandCenterSettings } from "../customization";
import { nextDelivery, projectHealth, unmetDependencies } from "./logic";

export type ProjectDirectoryStatus = "all" | "active" | "attention" | "untracked" | "complete";
export type ProjectDirectorySort = "activity" | "name" | "attention" | "delivery" | "manual";
export type ProjectDirectoryPageSize = 10 | 20 | 50;
export type ProjectEntry = CommandCenterSettings["projects"][number];
export type ProjectGroup = CommandCenterSettings["projectGroups"][number];

/** Key of a project's launcher entry: one per T3 project, so clones never share pins or groups. */
export const projectEntryKey = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  scopedProjectKey(scopeProjectRef(project.environmentId, project.id));

const normalize = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const compareNumber = (left: number, right: number) => (left === right ? 0 : left < right ? -1 : 1);
const HEALTH_ORDER = { red: 0, amber: 1, green: 2 } as const;

/**
 * Latest thread per project key among the ones the sidebar lists (unarchived, not a subagent
 * child), by its "updated" order.
 */
export function latestThreadByProject<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "projectId" | "archivedAt"> & {
    readonly lineage: Pick<EnvironmentThreadShell["lineage"], "relationshipToParent">;
  } & ThreadSortInput,
>(shells: ReadonlyArray<T>) {
  const latest = new Map<string, { readonly shell: T; readonly at: number }>();
  for (const shell of shells) {
    if (shell.archivedAt !== null || shell.lineage.relationshipToParent === "subagent") continue;
    const key = projectEntryKey({ environmentId: shell.environmentId, id: shell.projectId });
    const at = getThreadSortTimestamp(shell, "updated_at");
    const current = latest.get(key);
    if (!current || at > current.at) latest.set(key, { shell, at });
  }
  return latest;
}

/** Filters and orders the complete directory, pinned first; callers page it with `paginateCollection`. */
export function filterProjectDirectory({
  projects,
  sectionsByProject,
  query,
  environmentId,
  status,
  sort,
  today,
  activeAgentCounts,
  entries = new Map(),
  groupId = null,
  activity = new Map(),
  order = [],
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly sectionsByProject: ReadonlyMap<ProjectId, ReadonlyArray<CommandCenterSection>>;
  readonly query: string;
  readonly environmentId: string | null;
  readonly status: ProjectDirectoryStatus;
  readonly sort: ProjectDirectorySort;
  readonly order?: ReadonlyArray<string>;
  readonly today: string;
  readonly activeAgentCounts?: ReadonlyMap<ProjectId, number>;
  /** Launcher entries by `projectEntryKey`. */
  readonly entries?: ReadonlyMap<string, ProjectEntry>;
  /** Only projects in this group; null shows every project. */
  readonly groupId?: string | null;
  /** Latest activity by `projectEntryKey`, as `latestThreadByProject` returns it. */
  readonly activity?: ReadonlyMap<string, { readonly at: number }>;
}) {
  const search = normalize(query);
  const unmet = unmetDependencies([...sectionsByProject.values()].flat());
  const directory = projects.flatMap((project) => {
    if (environmentId !== null && project.environmentId !== environmentId) return [];
    const key = projectEntryKey(project);
    const entry = entries.get(key);
    if (groupId !== null && entry?.groupId !== groupId) return [];
    const name = normalize(project.title);
    if (search && !name.includes(search) && !normalize(project.workspaceRoot).includes(search)) {
      return [];
    }
    const sections = sectionsByProject.get(project.id) ?? [];
    const complete = sections.length > 0 && sections.every((section) => section.status === "done");
    const health = projectHealth({
      sections,
      today,
      activeAgents: activeAgentCounts?.get(project.id) ?? 0,
      waitingSections: sections.filter((section) => unmet.has(section.id)).length,
    });
    if (
      (status === "active" && (sections.length === 0 || complete)) ||
      (status === "attention" && health.level === "green") ||
      (status === "untracked" && sections.length > 0) ||
      (status === "complete" && !complete)
    ) {
      return [];
    }
    return [
      {
        project,
        name,
        pinned: entry?.pinned === true,
        health: HEALTH_ORDER[health.level],
        delivery: nextDelivery(sections, today)?.days ?? Infinity,
        activity: activity.get(key)?.at ?? -Infinity,
      },
    ];
  });
  const manual = compareManual(order);
  directory.sort((left, right) => {
    const order =
      sort === "manual"
        ? manual(projectEntryKey(left.project), projectEntryKey(right.project))
        : sort === "attention"
          ? left.health - right.health
          : sort === "delivery"
            ? compareNumber(left.delivery, right.delivery)
            : sort === "activity"
              ? compareNumber(right.activity, left.activity)
              : 0;
    return (
      Number(right.pinned) - Number(left.pinned) ||
      order ||
      compareText(left.name, right.name) ||
      compareText(left.project.environmentId, right.project.environmentId) ||
      compareText(left.project.id, right.project.id)
    );
  });
  return directory.map(({ project }) => project);
}

/**
 * Applies `patch` to the entries of `keys`, creating missing ones. Entries back at their
 * defaults are dropped, so the saved list only holds projects the user customized.
 */
export function updateProjectEntries(
  entries: ReadonlyArray<ProjectEntry>,
  keys: Iterable<string>,
  patch: Partial<Omit<ProjectEntry, "key">>,
): ProjectEntry[] {
  const targets = new Set(keys);
  const next = entries.map((entry) => (targets.has(entry.key) ? { ...entry, ...patch } : entry));
  for (const entry of entries) targets.delete(entry.key);
  for (const key of targets) next.push({ key, pinned: false, groupId: null, url: null, ...patch });
  return next.filter((entry) => entry.pinned || entry.groupId !== null || entry.url !== null);
}

/**
 * Drops entries of projects gone from a machine whose project list is known
 * (`liveEnvironmentIds`), so removed or re-added projects stop counting toward the cap. Entries
 * of offline machines stay.
 */
export function pruneProjectEntries(
  entries: ReadonlyArray<ProjectEntry>,
  projects: ReadonlyArray<Pick<EnvironmentProject, "environmentId" | "id">>,
  liveEnvironmentIds: ReadonlySet<string>,
): ProjectEntry[] {
  const present = new Set(projects.map(projectEntryKey));
  return entries.filter((entry) => {
    const ref = parseScopedProjectKey(entry.key);
    return ref !== null && (present.has(entry.key) || !liveEnvironmentIds.has(ref.environmentId));
  });
}

/** Pinned projects first, otherwise in the given order, for pickers. */
export function pinnedFirst<T extends Pick<EnvironmentProject, "environmentId" | "id">>(
  projects: ReadonlyArray<T>,
  entries: ReadonlyArray<ProjectEntry>,
): T[] {
  const pinned = new Set(entries.filter((entry) => entry.pinned).map((entry) => entry.key));
  if (pinned.size === 0) return [...projects];
  const first: T[] = [];
  const rest: T[] = [];
  for (const project of projects)
    (pinned.has(projectEntryKey(project)) ? first : rest).push(project);
  return [...first, ...rest];
}
