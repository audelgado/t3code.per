import type { LinkStatus, Machine, Task } from "./types.ts";
import type { ProviderPause } from "./view.ts";

/** Explain the same gates the dispatcher waits on, including failed dependencies. */
export function queueReason(task: Task, tasks: Map<string, Task>, machine: Machine | undefined, status: LinkStatus, pauses: ProviderPause[] = []): string | null {
  if (task.status !== "queued") return null;
  for (const id of task.dependsOn) {
    const dep = tasks.get(id);
    if (dep?.status === "done") continue;
    if (!dep) return "Una tarea previa ya no existe. Revisá las dependencias.";
    if (dep.status === "cancelled" || dep.status === "failed") return `Bloqueada: «${dep.title}» ${dep.status === "cancelled" ? "fue cancelada" : "falló"}. Reintenta ese paso para continuar la cadena.`;
    return `Espera a «${dep.title}» (${dep.status === "needs_you" || dep.status === "pending_approval" ? "necesita tu respuesta" : "sin terminar"}).`;
  }
  if (!machine?.enabled) return "El sistema está deshabilitado.";
  if (status !== "online") return `Esperando conexión con ${machine.label}.`;
  if (!task.runtimeMode) return "Falta aprobar los permisos de ejecución.";
  const active = [...tasks.values()].filter((t) => t.machineId === task.machineId && ["starting", "running", "needs_you"].includes(t.status));
  if (active.length >= machine.maxConcurrent) return `${machine.label} tiene sus ${machine.maxConcurrent} cupos ocupados.`;
  const root = [...tasks.values()].find((t) => t.id !== task.id && t.machineId === task.machineId && t.projectId === task.projectId && t.workspace.type === "root" && ["starting", "running", "waiting", "needs_you"].includes(t.status));
  if (task.workspace.type === "root" && root) return `Espera a «${root.title}»: comparten la carpeta del proyecto.`;
  const pause = pauses.find((p) => p.machineId === task.machineId && p.instanceId === task.model?.instanceId);
  if (pause) return `El proveedor alcanzó su límite de uso hasta ${pause.until}.`;
  return "Lista para iniciar automáticamente en el próximo despacho.";
}
