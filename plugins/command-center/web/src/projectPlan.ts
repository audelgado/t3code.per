import type { MemoryEntry } from "../../server/memory.ts";
import type { Section } from "../../server/sections.ts";

/** Filter only this project's checklist; section counts describe milestones, not these todos. */
export function planTodos(entries: MemoryEntry[], projectId: string, filter: string, query: string, sectionId: string) {
  const needle = query.trim().toLocaleLowerCase();
  return entries.filter((e) => e.projectId === projectId && e.kind === "todo"
    && (filter === "all" || e.done === (filter === "done"))
    && (!sectionId || (sectionId === "none" ? !e.sectionId : e.sectionId === sectionId))
    && (!needle || e.text.toLocaleLowerCase().includes(needle)));
}

export function planMilestones(sections: Section[], projectId: string) {
  const mine = sections.filter((s) => s.projectId === projectId)
    .sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  return { sections: mine, done: mine.filter((s) => s.status === "done").length,
    blocked: mine.filter((s) => s.status === "blocked" || !!s.blocker) };
}
