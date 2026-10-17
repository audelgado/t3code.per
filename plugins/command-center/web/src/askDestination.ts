import type { MachineProjects } from "../../server/types.ts";

export interface AskDestination { machineId: string; key: string }

/** A project always belongs to the explicitly chosen machine, including machines with no projects. */
export function askDestination(groups: MachineProjects[], machineId: string, key: string): AskDestination {
  const machine = groups.find((g) => g.machineId === machineId)
    ?? groups.find((g) => g.projects.some((p) => `${g.machineId}:${p.id}` === key))
    ?? groups.find((g) => g.projects.length > 0)
    ?? groups[0];
  if (!machine) return { machineId: "", key: "" };
  const selected = machine.projects.find((p) => `${machine.machineId}:${p.id}` === key) ?? machine.projects[0];
  return { machineId: machine.machineId, key: selected ? `${machine.machineId}:${selected.id}` : "" };
}
