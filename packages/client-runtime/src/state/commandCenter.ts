import type {
  CommandCenterEntity,
  CommandCenterSnapshot,
  CommandCenterStreamEvent,
} from "@t3tools/contracts";

const SNAPSHOT_KEY = {
  agentProfile: "agentProfiles",
  team: "teams",
  assignment: "assignments",
  section: "sections",
  memory: "memory",
  income: "income",
  cost: "costs",
} as const satisfies Record<CommandCenterEntity, keyof CommandCenterSnapshot>;

// Runs on Hermes (mobile), which lacks the ES2023 copying array methods such as `with`.
function upsertRow<T extends { readonly id: string }>(rows: ReadonlyArray<T>, row: T) {
  const index = rows.findIndex((existing) => existing.id === row.id);
  if (index === -1) return [...rows, row];
  const next = rows.slice();
  next[index] = row;
  return next;
}

/**
 * Folds one `commandCenter.subscribe` event into the current snapshot. Changes that
 * arrive before the first snapshot are dropped (the snapshot already includes them).
 */
export function applyCommandCenterEvent(
  current: CommandCenterSnapshot | null,
  event: CommandCenterStreamEvent,
): CommandCenterSnapshot | null {
  if (event.type === "snapshot") return event.snapshot;
  if (current === null) return null;
  if (event.type === "deleted") {
    const key = SNAPSHOT_KEY[event.entity];
    return { ...current, [key]: current[key].filter((row) => row.id !== event.id) };
  }
  const { record } = event;
  switch (record.entity) {
    case "agentProfile":
      return { ...current, agentProfiles: upsertRow(current.agentProfiles, record.value) };
    case "team":
      return { ...current, teams: upsertRow(current.teams, record.value) };
    case "assignment":
      return { ...current, assignments: upsertRow(current.assignments, record.value) };
    case "section":
      return { ...current, sections: upsertRow(current.sections, record.value) };
    case "memory":
      return { ...current, memory: upsertRow(current.memory, record.value) };
    case "income":
      return { ...current, income: upsertRow(current.income, record.value) };
    case "cost":
      return { ...current, costs: upsertRow(current.costs, record.value) };
  }
}
