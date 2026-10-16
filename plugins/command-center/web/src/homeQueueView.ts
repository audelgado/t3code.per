// Pure view logic for Hoy and the thread overlay (the screens are Home.tsx and ThreadSheet.tsx).
import type { HomeView, TaskItem, ThreadItem } from "../../server/types.ts";
import type { Tone } from "./look.ts";

/** A failed task counts as "needs you" for this long after it finished. */
export const FAILED_RECENT_MS = 86_400_000;

/** Resolve sheets against the complete loaded snapshot, independently of pagination. */
export function homeThread(view: HomeView, key: string | null) {
  return [...view.needsYou.flatMap((n) => (n.kind === "thread" ? [n.thread] : [])), ...view.running, ...view.done].find((t) => t.key === key);
}

export function matchesSearch(query: string, ...fields: (string | null | undefined)[]) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

// ---- what a thread asks of you ----

export type ThreadReason = "approval" | "input" | "plan";
const APPROVAL_KINDS = new Set(["command", "file-read", "file-change", "permission"]);
const REQUEST_LABELS: Record<string, string> = {
  command: "Ejecutar un comando",
  "file-read": "Leer archivos",
  "file-change": "Cambiar archivos",
  permission: "Pedir un permiso",
  user_input: "Te hace una pregunta",
  "mcp-elicitation": "Te hace una pregunta",
};
export const requestKindLabel = (kind: string) => REQUEST_LABELS[kind] ?? "Espera tu respuesta";

/** Primary button per reason. Approvals and plans open the overlay, where the decision is made. */
export const REASON_ACTION: Record<ThreadReason, string> = { approval: "Aprobar", input: "Responder", plan: "Revisar plan" };

/** Why a thread needs you, from what the live row reports; null when it asks nothing. */
export function threadReason(t: Pick<ThreadItem, "pending" | "planReady">): ThreadReason | null {
  if (t.pending) return APPROVAL_KINDS.has(t.pending.kind) ? "approval" : "input";
  return t.planReady ? "plan" : null;
}

/** One line saying what the thread waits for ("Cambiar archivos · src/a.ts"). */
export function threadWhy(t: Pick<ThreadItem, "pending" | "planReady">, reason: ThreadReason | null = threadReason(t)): string {
  if (reason === "plan") return "Plan listo para revisar";
  if (!t.pending) return "";
  const label = requestKindLabel(t.pending.kind);
  return t.pending.summary ? `${label} · ${t.pending.summary}` : label;
}

// ---- Hoy: Te necesita ----

export interface HomeNeed {
  key: string;
  tone: Tone;
  title: string;
  /** "<machineId>:<projectId>"; null for flows and machine alerts. */
  projectKey: string | null;
  /** Project title, or the machine's label when the project is not known yet. */
  project: string | null;
  why: string;
  since: string;
  alert: boolean;
  /** Where the row opens. */
  href: string;
  /** Inline primary action: a link, or retry of a failed task. */
  action: { label: string; href: string } | { label: string; retry: string };
}

const recentFailed = (view: HomeView, now: number) =>
  view.queue.filter((t) => t.status === "failed" && now - Date.parse(t.finishedAt ?? t.updatedAt) < FAILED_RECENT_MS);

/** How many rows homeNeeds returns: the badge on the sidebar and the tab bar must match the figure on Hoy. */
export const needsCount = (view: HomeView, now = Date.now()) => view.needsYou.length + recentFailed(view, now).length;

/** Context the rows need that HomeView does not carry. */
export interface HomeNeedContext {
  projectTitle(key: string): string | undefined;
  hashes: { thread(key: string): string; task(id: string): string; run(id: string): string; fleet: string };
  now?: number;
}

const firstLine = (s: string | null) => s?.split("\n").find((l) => l.trim())?.trim() ?? null;
const sourceName = (task: Pick<TaskItem, "source">) => (task.source === "user" ? "Vos" : task.source.slice(6));

/**
 * Everything waiting on you, oldest first, machine alerts last. Includes tasks that failed in the last 24 h
 * (the only thing here that retries inline). Never paged by the caller.
 */
export function homeNeeds(view: HomeView, ctx: HomeNeedContext): HomeNeed[] {
  const now = ctx.now ?? Date.now();
  const machine = (id: string) => view.machines.find((m) => m.id === id)?.label ?? null;
  const out: HomeNeed[] = [];
  for (const n of view.needsYou) {
    if (n.kind === "thread") {
      const key = `${n.thread.machineId}:${n.thread.projectId}`;
      const href = ctx.hashes.thread(n.thread.key);
      out.push({
        key: n.thread.key, tone: "need", title: n.thread.title, projectKey: key, project: ctx.projectTitle(key) ?? machine(n.thread.machineId),
        why: threadWhy(n.thread, n.reason), since: n.since, alert: false, href, action: { label: REASON_ACTION[n.reason], href },
      });
    } else if (n.kind === "task_approval") {
      const key = `${n.task.machineId}:${n.task.projectId}`;
      const href = ctx.hashes.task(n.task.id);
      out.push({
        key: `task:${n.task.id}`, tone: "need", title: n.task.title, projectKey: key, project: n.task.projectTitle,
        why: `${sourceName(n.task)} quiere encolar esta tarea`, since: n.since, alert: false, href, action: { label: "Aprobar", href },
      });
    } else if (n.kind === "workflow") {
      const href = ctx.hashes.run(n.runId);
      out.push({ key: n.key, tone: "need", title: n.title, projectKey: null, project: "Flujo", why: n.text, since: n.since, alert: false, href, action: { label: "Abrir", href } });
    } else {
      out.push({
        key: n.alert.key, tone: "fail", title: n.alert.message, projectKey: null, project: n.alert.machineId ? machine(n.alert.machineId) : null,
        why: "", since: n.since, alert: true, href: ctx.hashes.fleet, action: { label: "Ver", href: ctx.hashes.fleet },
      });
    }
  }
  for (const t of recentFailed(view, now)) {
    const finished = t.finishedAt ?? t.updatedAt;
    out.push({
      key: `task:${t.id}`, tone: "fail", title: t.title, projectKey: `${t.machineId}:${t.projectId}`, project: t.projectTitle,
      why: firstLine(t.error) ?? "Falló", since: finished, alert: false, href: ctx.hashes.task(t.id), action: { label: "Reintentar", retry: t.id },
    });
  }
  return out.sort((a, b) => Number(a.alert) - Number(b.alert) || a.since.localeCompare(b.since));
}

/** The four figures on top of Hoy. `needs` is the length of homeNeeds. */
export function homeCounts(view: HomeView, needs: number) {
  return { needs, running: view.running.length, queued: view.queue.filter((t) => t.status === "queued").length, done: view.done.length };
}

// ---- plan review ----

const STEP_LINE = /^\s*(?:\d+[.)]|[-*\u2022])\s+(\S.*)$/;

/**
 * The steps of a plan from the thread's last assistant text: numbered or bulleted lines, markdown emphasis stripped.
 * Null when the text does not look like a list, so the sheet shows it as plain text instead.
 */
export function planSteps(text: string | null): string[] | null {
  const steps = (text ?? "").split(/\r?\n/).flatMap((line) => {
    const m = STEP_LINE.exec(line);
    return m ? [m[1]!.replace(/\*\*|__|`/g, "").trim()] : [];
  });
  return steps.length >= 2 ? steps : null;
}
