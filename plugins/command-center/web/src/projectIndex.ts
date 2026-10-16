import { useEffect, useState } from "react";
import type { MachineProjects } from "../../server/types.ts";
import { call } from "./api.ts";

/** Projects flattened for pickers: sections, memory and artifacts store the T3 project id, which is the same on every machine. */
export function indexProjects(machines: MachineProjects[]) {
  const byId = new Map<string, { id: string; title: string; key: string }>();
  for (const m of machines) for (const p of m.projects) if (!byId.has(p.id)) byId.set(p.id, { id: p.id, title: p.title, key: `${m.machineId}:${p.id}` });
  return {
    list: [...byId.values()].sort((a, b) => a.title.localeCompare(b.title)),
    /** Name for a project id, or the id itself when the project is gone. */
    title: (id: string) => byId.get(id)?.title ?? id,
    /** "<machineId>:<projectId>" for colours and links; null when the project is gone. */
    key: (id: string) => byId.get(id)?.key ?? null,
  };
}

/** Loads the project list once. */
export function useProjectIndex() {
  const [machines, setMachines] = useState<MachineProjects[]>([]);
  useEffect(() => {
    call("GET /api/projects").then(setMachines, () => {});
  }, []);
  return indexProjects(machines);
}
