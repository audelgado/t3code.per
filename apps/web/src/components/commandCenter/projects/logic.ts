import {
  type CommandCenterMemoryEntry,
  type CommandCenterSection,
  type CommandCenterSectionStatus,
  type EnvironmentId,
  type ProjectId,
  pullRequestNumberFromUrl,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { AT_RISK_PERCENT, sectionPercent } from "@t3tools/client-runtime/state/commandCenterDerive";

/** Days shown on the delivery strip. */
export const STRIP_DAYS = 35;

export const SECTION_STATUS_LABEL: Record<CommandCenterSectionStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  review: "To review",
  blocked: "Blocked",
  done: "Done",
};

const pad = (value: number) => String(value).padStart(2, "0");

/** Local calendar day of `now`, as `YYYY-MM-DD`. */
export function localDate(now: number) {
  const date = new Date(now);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string) {
  return Math.round(dayNumber(to) - dayNumber(from));
}

/** Adds days to a `YYYY-MM-DD` day. */
export function addDays(day: string, days: number) {
  return new Date((dayNumber(day) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function dueLabel(days: number) {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "1 day late";
  return days > 0 ? `in ${days} days` : `${-days} days late`;
}

/** Sections in display order. */
export function sortSections(sections: ReadonlyArray<CommandCenterSection>) {
  return sections.toSorted(
    (left, right) => left.sortKey - right.sortKey || left.createdAt.localeCompare(right.createdAt),
  );
}

export interface NextDelivery {
  readonly section: CommandCenterSection;
  readonly days: number;
}

/** Earliest open section due today or later. */
export function nextDelivery(
  sections: ReadonlyArray<CommandCenterSection>,
  today: string,
): NextDelivery | null {
  let next: NextDelivery | null = null;
  for (const section of sections) {
    if (section.status === "done" || section.dueDate === null) continue;
    const days = daysBetween(today, section.dueDate);
    if (days >= 0 && (next === null || days < next.days)) next = { section, days };
  }
  return next;
}

export function countByStatus(sections: ReadonlyArray<CommandCenterSection>) {
  const counts: Record<CommandCenterSectionStatus, number> = {
    todo: 0,
    in_progress: 0,
    review: 0,
    blocked: 0,
    done: 0,
  };
  for (const section of sections) counts[section.status] += 1;
  return counts;
}

/** Open sections due inside the strip window, with their position as a 0-100 percentage. */
export function stripMarkers(sections: ReadonlyArray<CommandCenterSection>, today: string) {
  return sections.flatMap((section) => {
    if (section.status === "done" || section.dueDate === null) return [];
    const days = daysBetween(today, section.dueDate);
    return days >= 0 && days <= STRIP_DAYS
      ? [{ section, days, left: (days / STRIP_DAYS) * 100 }]
      : [];
  });
}

export function projectProgress(sections: ReadonlyArray<CommandCenterSection>) {
  let done = 0;
  let total = 0;
  let delivered = 0;
  for (const section of sections) {
    done += Math.min(section.tasksDone, section.tasksTotal);
    total += section.tasksTotal;
    if (section.status === "done") delivered += 1;
  }
  return { done, total, delivered, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * "Where we left off" for one project: the newest progress someone wrote, the newest daily
 * digest (source `system`, shown under it so it never hides agent work), and open todos
 * oldest first.
 */
export function whereWeLeftOff(
  memory: ReadonlyArray<CommandCenterMemoryEntry>,
  projectId: ProjectId,
) {
  let progress: CommandCenterMemoryEntry | null = null;
  let digest: CommandCenterMemoryEntry | null = null;
  const todos: CommandCenterMemoryEntry[] = [];
  for (const entry of memory) {
    if (entry.projectId !== projectId) continue;
    if (entry.kind === "progress") {
      const latest = entry.source === "system" ? digest : progress;
      if (latest !== null && entry.createdAt <= latest.createdAt) continue;
      if (entry.source === "system") digest = entry;
      else progress = entry;
    } else if (entry.kind === "todo" && !entry.done) {
      todos.push(entry);
    }
  }
  todos.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { progress, digest, todos };
}

/**
 * Plan steps for a project's "Ask the team": each missing item of an open section (tied to that
 * section), then each open todo. Handed to the plan drawer as steps, so text with commas or
 * "and" stays one step. Interview questions ("Question: " todos) are for the user, not agents.
 */
export function delegationSteps(
  sections: ReadonlyArray<CommandCenterSection>,
  todos: ReadonlyArray<CommandCenterMemoryEntry>,
) {
  return [
    ...sections.flatMap((section) =>
      section.status === "done"
        ? []
        : section.missing.map((item) => ({
            text: `${section.name}: ${item}`,
            sectionId: section.id,
          })),
    ),
    ...todos.flatMap((todo) =>
      todo.text.startsWith("Question: ") ? [] : [{ text: todo.text, sectionId: todo.sectionId }],
    ),
  ];
}

/** Missing items, one per line in the editor. */
export function parseMissing(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Unmet dependencies per open section, across projects: the sections it waits on that are not
 * done yet. Dependencies pointing at a deleted section are ignored.
 */
export function unmetDependencies(
  sections: ReadonlyArray<CommandCenterSection>,
): ReadonlyMap<CommandCenterSection["id"], ReadonlyArray<CommandCenterSection>> {
  const byId = new Map(sections.map((section) => [section.id, section] as const));
  const unmet = new Map<CommandCenterSection["id"], CommandCenterSection[]>();
  for (const section of sections) {
    if (section.status === "done") continue;
    const waiting = section.dependsOn.flatMap((id) => {
      const dependency = byId.get(id);
      return dependency && dependency.status !== "done" && dependency.id !== section.id
        ? [dependency]
        : [];
    });
    if (waiting.length > 0) unmet.set(section.id, waiting);
  }
  return unmet;
}

export type ProjectHealthLevel = "green" | "amber" | "red";

/**
 * Health light for one project. Red: something overdue, blocked, or due within 2 days under
 * 70% done. Amber: due within 7 days under 70%, waiting on another section, or open work in
 * progress with no agent working on it. Green otherwise. Reasons explain the light.
 */
export function projectHealth({
  sections,
  today,
  activeAgents,
  waitingSections,
}: {
  readonly sections: ReadonlyArray<CommandCenterSection>;
  readonly today: string;
  readonly activeAgents: number;
  readonly waitingSections: number;
}): { level: ProjectHealthLevel; reasons: string[] } {
  const red: string[] = [];
  const amber: string[] = [];
  for (const section of sections) {
    if (section.status === "done") continue;
    if (section.status === "blocked") red.push(`${section.name} is blocked`);
    if (section.dueDate === null || section.status === "review") continue;
    const days = daysBetween(today, section.dueDate);
    const percent = sectionPercent(section);
    if (days < 0) red.push(`${section.name} is ${dueLabel(days)}`);
    else if (percent < AT_RISK_PERCENT && days <= 2)
      red.push(`${section.name} due ${dueLabel(days)} at ${percent}%`);
    else if (percent < AT_RISK_PERCENT && days <= 7)
      amber.push(`${section.name} due ${dueLabel(days)} at ${percent}%`);
  }
  if (waitingSections > 0) {
    amber.push(`${waitingSections} section${waitingSections === 1 ? "" : "s"} waiting on others`);
  }
  if (activeAgents === 0 && sections.some((section) => section.status === "in_progress")) {
    amber.push("Work in progress but no agent is on it");
  }
  if (red.length > 0) return { level: "red", reasons: [...red, ...amber] };
  if (amber.length > 0) return { level: "amber", reasons: amber };
  return { level: "green", reasons: [] };
}

/**
 * A pasted pull request link as `setSectionPullRequest` takes it, or null when it is not a web
 * address. Links outside GitHub, GitLab and Bitbucket still save, just without a number.
 */
export function pullRequestLinkFromInput(text: string) {
  const prUrl = text.trim();
  if (prUrl.length > 2_000 || !/^https?:\/\/\S+$/i.test(prUrl)) return null;
  return { prUrl, prNumber: pullRequestNumberFromUrl(prUrl) };
}

/** The project's recurring scheduled tasks (webhook tasks only run when called), next run first. */
export function recurringProjectTasks(
  tasks: ReadonlyArray<ScheduledTask>,
  projectId: ProjectId,
): ReadonlyArray<ScheduledTask> {
  const next = (task: ScheduledTask) =>
    task.enabled && task.nextRunAt !== null ? Date.parse(task.nextRunAt) : Infinity;
  return tasks
    .filter((task) => task.projectId === projectId && task.schedule.type !== "webhook")
    .toSorted((left, right) => next(left) - next(right));
}

/**
 * The thread a project's preview opens beside: the preview browser lives in a thread's panel,
 * so this is the most recently updated live thread of the project on that machine.
 */
export function previewThreadFor(
  shells: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
  }>,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): ThreadId | null {
  let best: (typeof shells)[number] | null = null;
  for (const shell of shells) {
    if (
      shell.environmentId !== environmentId ||
      shell.projectId !== projectId ||
      shell.archivedAt !== null ||
      shell.deletedAt !== null
    )
      continue;
    if (best === null || shell.updatedAt > best.updatedAt) best = shell;
  }
  return best?.id ?? null;
}
