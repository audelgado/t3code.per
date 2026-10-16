import type { WorkMachine, WorkRow } from "../../server/work.ts";
import { paginateCollection } from "./pagination.ts";

export interface WorkFilters {
  query: string;
  machineId: string;
  status: "all" | "active" | "tidy" | "pr";
}

export function workDirectory(machines: WorkMachine[], filters: WorkFilters, page: number, size = 5) {
  const query = filters.query.trim().toLowerCase();
  const selected = machines.filter((m) => !filters.machineId || m.id === filters.machineId);
  const matchesStatus = (row: WorkRow) => filters.status === "all"
    || (filters.status === "active" && row.agent !== "idle")
    || (filters.status === "tidy" && row.tidy !== null)
    || (filters.status === "pr" && row.pr !== null);
  const lanes = selected.flatMap((machine) => machine.lanes.flatMap((lane) => {
    const rows = lane.rows.filter((row) => matchesStatus(row) && (!query || `${lane.title} ${row.title} ${row.branch}`.toLowerCase().includes(query)));
    return rows.length ? [{ machine, lane, rows }] : [];
  }));
  return { machines: selected, pagination: paginateCollection(lanes, page, size) };
}
