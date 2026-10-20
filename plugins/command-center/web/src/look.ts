// Etiquetas en español neutro y formatos de fecha y número es-AR compartidos.
// Colours here mirror the --color-* tokens in index.css (the "Papel vivo" palette).
import type { LinkStatus, RuntimeMode, TaskStatus, ThreadStatus } from "../../server/types.ts";

// ---- project colour ----

export const PROJECT_PALETTE = ["#4f46e5", "#0891b2", "#0d9488", "#ea580c", "#db2777", "#c026d3", "#65a30d", "#a16207"] as const;

/** Stable colour for a project: pass "<machineId>:<projectId>" (or any stable key). */
export function projectColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
  return PROJECT_PALETTE[h % PROJECT_PALETTE.length]!;
}

// ---- status tones ----

export type Tone = "need" | "run" | "queue" | "ok" | "fail" | "pr" | "teal";
export const TONES: Record<Tone, { fg: string; bg: string }> = {
  need: { fg: "#b45309", bg: "#fef3c7" },
  run: { fg: "#1d4ed8", bg: "#dbeafe" },
  queue: { fg: "#475569", bg: "#f1f5f9" },
  ok: { fg: "#15803d", bg: "#dcfce7" },
  fail: { fg: "#b91c1c", bg: "#fee2e2" },
  pr: { fg: "#6d28d9", bg: "#ede9fe" },
  teal: { fg: "#0f766e", bg: "#ccfbf1" },
};

type AnyStatus = TaskStatus | ThreadStatus | LinkStatus;
const STATUS: Record<AnyStatus, [label: string, tone: Tone]> = {
  pending_approval: ["Por aprobar", "need"],
  queued: ["En cola", "queue"],
  starting: ["Iniciando", "run"],
  running: ["En curso", "run"],
  waiting: ["Esperando", "need"],
  needs_you: ["Te necesita", "need"],
  done: ["Listo", "ok"],
  failed: ["Falló", "fail"],
  cancelled: ["Cancelada", "queue"],
  // thread-only
  idle: ["Inactivo", "queue"],
  preparing: ["Preparando", "run"],
  completed: ["Listo", "ok"],
  interrupted: ["Interrumpido", "fail"],
  rolled_back: ["Revertido", "queue"],
  // link-only
  connecting: ["Conectando", "run"],
  online: ["En línea", "ok"],
  offline: ["Sin conexión", "fail"],
  incompatible: ["Incompatible", "need"],
  unauthorized: ["Sin autorización", "fail"],
};

/** Spanish label and colours for any task, thread or machine-link status. */
export function statusTone(status: AnyStatus): { label: string; tone: Tone; fg: string; bg: string } {
  const [label, tone] = STATUS[status];
  return { label, tone, ...TONES[tone] };
}

// ---- labels ----

export const PRIORITIES = [[2, "Urgente"], [1, "Alta"], [0, "Normal"], [-1, "Baja"], [-2, "Mínima"]] as const;
export const priorityLabel = (n: number) => PRIORITIES.find(([v]) => v === Math.max(-2, Math.min(2, Math.round(n))))![1];

/** Git stages, in order; the index is `WorkRow.stage` from server/work.ts. */
export const STAGES = ["Creada", "Trabajando", "Commit", "Push", "PR abierto", "Mergeada", "Limpieza"] as const;
export const stageLabel = (i: number) => STAGES[Math.max(0, Math.min(STAGES.length - 1, i))]!;

export const RUNTIME_MODES: readonly (readonly [RuntimeMode, string])[] = [
  ["approval-required", "Preguntar antes de cada acción"],
  ["auto-accept-edits", "Aceptar ediciones"],
  ["auto", "Automático"],
  ["full-access", "Acceso total"],
];
export const runtimeModeLabel = (mode: RuntimeMode | null) => RUNTIME_MODES.find(([v]) => v === mode)?.[1] ?? "Sin definir";

export const MEMORY_KIND_LABELS = { progress: "Progreso", decision: "Decisión", todo: "Pendiente", handoff: "Traspaso", note: "Nota" } as const;
export const memoryKindLabel = (kind: string) => (MEMORY_KIND_LABELS as Record<string, string>)[kind] ?? kind;

export const SECTION_STATUS_LABELS = { todo: "Por hacer", in_progress: "En curso", review: "Revisión", blocked: "Bloqueada", done: "Lista" } as const;
export const sectionStatusLabel = (s: string) => (SECTION_STATUS_LABELS as Record<string, string>)[s] ?? s;

// ---- dates and numbers (es-AR) ----

const rtf = new Intl.RelativeTimeFormat("es-AR", { numeric: "always", style: "narrow" });
const dateTime = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const number = new Intl.NumberFormat("es-AR");

/** "hace 5 min" for an ISO timestamp; "ahora" under a minute. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "ahora";
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  return rtf.format(-Math.floor(s / 86400), "day");
}

/** Local date and time for an ISO timestamp, e.g. "16 oct, 14:05". */
export const at = (iso: string) => dateTime.format(new Date(iso));

export const fmtNumber = (n: number) => number.format(n);
