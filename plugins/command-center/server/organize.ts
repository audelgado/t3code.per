// "Ordenar con IA": a coordinator agent turns a dictated, messy request into a reviewable draft
// (clean prompt, project, priority, profile, steps, open questions). It runs as a short T3 thread on
// the selected destination, or the configured coordinator machine when none is supplied. The draft is only a
// proposal: the user edits it in Ask and queues it through the normal task/plan routes.
import { randomUUID } from "node:crypto";
import { assistantPrompt, parseAssistantReply, type AssistantContext, type AssistantMessage, type AssistantReply } from "./assistant.ts";
import { taskStatusFor } from "./dispatcher.ts";
import { HttpError, type Route } from "./http.ts";
import type { Profile } from "./profiles.ts";
import { T3Error, type Machine, type ProjectRow, type ProviderInfo, type T3Link, type ThreadRow } from "./types.ts";

export type CoordinatorId = "claude" | "codex" | "hermes";

export interface Coordinator {
  id: CoordinatorId;
  label: string;
  /** False when the coordinator machine has no enabled, installed provider for it. */
  available: boolean;
  /** Why it is unavailable, in Spanish, for the UI. Null when available. */
  reason: string | null;
}

export interface OrganizeInput {
  purpose?: "work" | "assistant";
  history?: AssistantMessage[];
  /** The dictated or typed request, as is. */
  text: string;
  coordinator: CoordinatorId;
  /** "<machineId>:<projectId>" the user already picked, as a hint. */
  projectKey?: string | null;
  /** Explicit execution destination; omission preserves the configured coordinator default. */
  targetProjectKey?: string | null;
}

export interface OrganizeStep {
  title: string;
  prompt: string;
}

export interface OrganizeDraft {
  title: string;
  /** The optimized prompt for the whole request. */
  prompt: string;
  /** "<machineId>:<projectId>" of a known project, or null when the coordinator could not tell. */
  projectKey: string | null;
  /** -2..2 (Mínima..Urgente), same scale as TaskInput.priority. */
  priority: number;
  profileId: string | null;
  /** Empty or 2-12 steps; one-step work stays in `prompt`. */
  steps: OrganizeStep[];
  /** What the coordinator could not decide and the user should answer before queueing. */
  questions: string[];
}

export interface OrganizeJob {
  reply?: AssistantReply;
  id: string;
  coordinator: CoordinatorId;
  status: "running" | "done" | "failed";
  draft: OrganizeDraft | null;
  /** Spanish, user-facing. Never contains a token. */
  error: string | null;
  createdAt: string;
}

declare module "./types.ts" {
  interface Api {
    "GET /api/organize/coordinators": { body: never; res: Coordinator[] };
    "POST /api/organize": { body: OrganizeInput; res: OrganizeJob };
    "GET /api/organize/:id": { body: never; res: OrganizeJob };
  }
}

const TIMEOUT_MS = 120_000;
const MAX_JOBS = 50;
const JOB_TTL_MS = 60 * 60_000;
const MAX_TEXT = 8000;
const COORDINATORS: { id: CoordinatorId; label: string; match: (p: ProviderInfo) => boolean }[] = [
  { id: "claude", label: "Claude", match: (p) => /claude/i.test(`${p.driver} ${p.instanceId}`) },
  { id: "codex", label: "Codex", match: (p) => /codex/i.test(`${p.driver} ${p.instanceId}`) },
  { id: "hermes", label: "Hermes", match: (p) => /hermes/i.test(`${p.instanceId} ${p.displayName} ${p.driver}`) },
];
const MISSING: Record<CoordinatorId, string> = {
  claude: "Claude Code no está instalado o habilitado en la VPS",
  codex: "Codex no está instalado o habilitado en la VPS",
  hermes: "Hermes no está configurado como proveedor ACP en la VPS",
};

export interface OrganizeDeps {
  assistantContext?: () => AssistantContext;
  machines: () => Machine[];
  projects: () => ProjectRow[];
  profiles: () => Pick<Profile, "id" | "name" | "rolePrompt">[];
  link: (machineId: string) => T3Link | undefined;
  /** Live shell rows of every machine (dispatcher.threads()). */
  threads: () => ThreadRow[];
  /** CC_COORDINATOR_MACHINE; default: the first enabled machine that is online. */
  machineId?: string;
  /** CC_COORDINATOR_PROJECT; default: the first project on the coordinator machine. */
  projectId?: string;
  now?: () => number;
  newId?: () => string;
  timeoutMs?: number;
}

interface Target {
  machine: Machine;
  link: T3Link;
  projectId: string;
}

interface Run {
  purpose: "work" | "assistant";
  history: AssistantMessage[];
  job: OrganizeJob;
  hint: string | null;
  targetProjectKey: string | null;
  startedAt: number;
  machineId: string | null;
  threadId: string | null;
  seen: boolean;
  finishing: boolean;
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Pulls the JSON object out of the coordinator's answer (code fences and surrounding text tolerated), validated and clamped. */
export function parseDraft(text: string | null, known: { projectKeys: Set<string>; profileIds: Set<string>; hint: string | null }): OrganizeDraft | null {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const prompt = str(o.prompt);
  if (!prompt) return null;
  const n = Number(o.priority);
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map((s: Partial<Record<keyof OrganizeStep, unknown>> | null) => ({ title: oneLine(str(s?.title), 80), prompt: str(s?.prompt) }))
    .filter((s) => s.title && s.prompt)
    .slice(0, 12);
  const key = (v: unknown) => (typeof v === "string" && known.projectKeys.has(v) ? v : null);
  return {
    title: oneLine(str(o.title) || prompt, 80),
    prompt,
    projectKey: key(o.projectKey) ?? key(known.hint),
    priority: Number.isFinite(n) ? Math.max(-2, Math.min(2, Math.round(n))) : 0,
    profileId: typeof o.profileId === "string" && known.profileIds.has(o.profileId) ? o.profileId : null,
    steps: steps.length >= 2 ? steps : [],
    questions: (Array.isArray(o.questions) ? o.questions : []).map((q) => oneLine(str(q), 300)).filter(Boolean).slice(0, 5),
  };
}

export function coordinatorPrompt(input: {
  text: string;
  hint: string | null;
  projects: { key: string; title: string; machine: string }[];
  profiles: Pick<Profile, "id" | "name" | "rolePrompt">[];
}): string {
  const projects = input.projects.slice(0, 100).map((p) => `- ${p.key} | ${oneLine(p.title, 80)} | ${oneLine(p.machine, 40)}`);
  const profiles = input.profiles.slice(0, 50).map((p) => `- ${p.id} | ${oneLine(p.name, 60)} | ${oneLine(p.rolePrompt, 120) || "sin rol"}`);
  return [
    "Sos el coordinador de Command Center. Convertí el pedido del usuario (dictado, puede venir desordenado) en un borrador de trabajo para un agente de código. El usuario lo revisa antes de encolarlo.",
    "",
    "Reglas:",
    "- No uses herramientas: no leas ni modifiques archivos, no ejecutes comandos, no busques nada. Solo respondé.",
    "- Respondé ÚNICAMENTE con un objeto JSON, sin texto antes ni después y sin bloques de código.",
    "- Escribí un prompt claro, completo y optimizado para un agente de código, en el idioma del pedido.",
    "- Respetá la intención del usuario. No inventes requisitos ni detalles que el pedido no dice.",
    '- Dividí en pasos (de 2 a 12) solo si el trabajo tiene partes que de verdad van en orden; si no, dejá "steps" vacío.',
    '- Agregá preguntas (máximo 5) solo para ambigüedades reales; si no hay, dejá "questions" vacío.',
    "- Toda la respuesta debe tener menos de 10000 caracteres.",
    "",
    'Forma exacta: {"title": "máximo 80 caracteres, en el idioma del pedido", "prompt": "...", "projectKey": "una clave de la lista o null", "priority": 0, "profileId": "un id de la lista o null", "steps": [{"title": "...", "prompt": "..."}], "questions": ["..."]}',
    "",
    "Prioridad (entero): 2 Urgente, 1 Alta, 0 Normal, -1 Baja, -2 Mínima. Usá 0 salvo que el pedido indique otra cosa.",
    "",
    "Proyectos (clave | título | máquina):",
    ...(projects.length ? projects : ["(ninguno)"]),
    ...(input.hint ? ["", `El usuario ya eligió el proyecto ${input.hint}; usalo salvo que el pedido diga claramente otro.`] : []),
    "",
    "Perfiles (id | nombre | rol):",
    ...(profiles.length ? profiles : ["(ninguno)"]),
    "",
    "Pedido:",
    '"""',
    input.text,
    '"""',
  ].join("\n");
}

/**
 * Jobs advance on dispatcher "changed" (every shell update plus its 30 s tick), so a timeout lands within ~30 s
 * of expiring. Wire-up: `dispatcher.on("changed", organize.advance); routes.push(...organize.routes)`.
 */
export function createOrganize(deps: OrganizeDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  // ponytail: in memory, so jobs are lost on restart (a draft is cheap to ask for again); persist if that bites.
  const runs = new Map<string, Run>();
  // ponytail: threads this service launched, kept past the job's TTL so they stay out of the UI; lost on restart (threads then show for up to 24 h).
  const owned = new Set<string>();

  /** The coordinator machine and project, or why there is none. */
  function target(targetProjectKey?: string | null): Target | string {
    if (targetProjectKey) {
      const project = deps.projects().find((p) => `${p.machineId}:${p.id}` === targetProjectKey);
      if (!project) return "El proyecto elegido ya no está disponible";
      const machine = deps.machines().find((m) => m.id === project.machineId && m.enabled);
      if (!machine) return "El sistema elegido no está disponible";
      const link = deps.link(machine.id);
      if (link?.state.status !== "online") return `${machine.label} está desconectada`;
      return { machine, link, projectId: project.id };
    }
    const enabled = deps.machines().filter((m) => m.enabled);
    const withProject = enabled.filter((m) => deps.projects().some((p) => p.machineId === m.id && (!deps.projectId || p.id === deps.projectId)));
    const machine = deps.machineId
      ? enabled.find((m) => m.id === deps.machineId)
      : (withProject.find((m) => deps.link(m.id)?.state.status === "online") ?? withProject[0] ?? enabled[0]);
    if (!machine)
      return deps.machineId ? "La máquina coordinadora (CC_COORDINATOR_MACHINE) no existe o está deshabilitada" : "No hay ninguna máquina para coordinar";
    const link = deps.link(machine.id);
    if (link?.state.status !== "online") return `${machine.label} está desconectada`;
    const projects = deps.projects().filter((p) => p.machineId === machine.id);
    const project = deps.projectId ? projects.find((p) => p.id === deps.projectId) : projects[0];
    if (!project)
      return deps.projectId ? `El proyecto coordinador (CC_COORDINATOR_PROJECT) no está en ${machine.label}` : `${machine.label} no tiene proyectos`;
    return { machine, link, projectId: project.id };
  }

  async function coordinators(targetProjectKey?: string | null) {
    const t = target(targetProjectKey);
    let providers: ProviderInfo[] = [];
    let reason = typeof t === "string" ? t : null;
    if (typeof t !== "string") {
      try {
        providers = (await t.link.providers()).filter((p) => p.enabled && p.installed && p.models.length > 0);
      } catch {
        reason = `No se pudieron leer los proveedores de ${t.machine.label}`;
      }
    }
    return COORDINATORS.map((c) => {
      const provider = reason ? null : (providers.find(c.match) ?? null);
      const coordinator: Coordinator = { id: c.id, label: c.label, available: provider !== null, reason: provider ? null : (reason ?? MISSING[c.id]) };
      return { coordinator, provider, target: typeof t === "string" ? null : t };
    });
  }

  function prune() {
    const cutoff = now() - JOB_TTL_MS;
    for (const [id, run] of runs) if (run.startedAt < cutoff) runs.delete(id);
    // A Map iterates in insertion order: the first keys are the oldest.
    for (const id of runs.keys()) {
      if (runs.size <= MAX_JOBS) break;
      runs.delete(id);
    }
  }

  /** Interrupts a live run and settles its thread, best effort. Nothing is ever approved. */
  function stop(run: Run): Promise<void> {
    const link = run.machineId ? deps.link(run.machineId) : undefined;
    const threadId = run.threadId;
    if (!link || !threadId) return Promise.resolve();
    const row = deps.threads().find((r) => r.machineId === run.machineId && r.id === threadId);
    const interrupt = row?.activeRunId ? link.interrupt(threadId, row.activeRunId) : Promise.resolve();
    return interrupt
      .catch(() => {})
      .then(() => link.settle(threadId))
      .catch(() => {});
  }

  function fail(run: Run, error: string) {
    if (run.job.status !== "running") return;
    run.job = { ...run.job, status: "failed", error };
    void stop(run);
  }

  async function start(run: Run, text: string) {
    const entry = (await coordinators(run.targetProjectKey)).find((c) => c.coordinator.id === run.job.coordinator)!;
    if (!entry.provider || !entry.target) return fail(run, entry.coordinator.reason ?? MISSING[run.job.coordinator]);
    const { machine, link, projectId } = entry.target;
    const model = entry.provider.models.find((m) => m.isDefault) ?? entry.provider.models[0]!;
    const labels = new Map(deps.machines().map((m) => [m.id, m.label]));
    const prompt = run.purpose === "assistant" ? assistantPrompt(text, run.history, deps.assistantContext!()) : coordinatorPrompt({
      text,
      hint: run.hint,
      projects: deps.projects().map((p) => ({ key: `${p.machineId}:${p.id}`, title: p.title, machine: labels.get(p.machineId) ?? p.machineId })),
      profiles: deps.profiles(),
    });
    if (run.job.status !== "running") return;
    run.machineId = machine.id;
    run.threadId = newId();
    owned.add(`${machine.id}:${run.threadId}`);
    try {
      await link.launch({
        commandId: newId(),
        threadId: run.threadId,
        projectId,
        title: `${run.purpose === "assistant" ? "Asistente CC" : "Ordenar"}: ${oneLine(text, 50)}`,
        modelSelection: { instanceId: entry.provider.instanceId, model: model.slug },
        // The most restrictive mode: any tool use raises an approval request, which fails the job (see advance).
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        prompt,
      });
    } catch (e) {
      fail(run, e instanceof T3Error ? `T3 rechazó el pedido al coordinador: ${oneLine(e.message, 200)}` : `No se pudo contactar a ${machine.label}`);
    }
    void advance(); // the thread may already be visible
  }

  async function finish(run: Run) {
    run.finishing = true;
    let text: string | null = null;
    try {
      text = (await deps.link(run.machineId!)?.readResult(run.threadId!))?.text ?? null;
    } catch {
      // treated as an empty answer
    }
    run.finishing = false;
    if (run.job.status !== "running") return;
    if (run.purpose === "assistant") {
      const reply = parseAssistantReply(text, deps.assistantContext!());
      if (!reply) return fail(run, "El asistente no devolvió una respuesta válida. Probá de nuevo.");
      run.job = { ...run.job, status: "done", reply };
      await stop(run);
      return;
    }
    const draft = parseDraft(text, {
      projectKeys: new Set(deps.projects().map((p) => `${p.machineId}:${p.id}`)),
      profileIds: new Set(deps.profiles().map((p) => p.id)),
      hint: run.hint,
    });
    if (!draft) return fail(run, "El coordinador no devolvió un borrador válido");
    run.job = { ...run.job, status: "done", draft };
    await stop(run);
  }

  /** Moves running jobs forward from the live rows. Safe to call any time; the promise is for tests. */
  function advance(): Promise<void> {
    const t = now();
    const rows = deps.threads();
    const reading: Promise<void>[] = [];
    for (const run of runs.values()) {
      if (run.job.status !== "running" || run.finishing) continue;
      if (t - run.startedAt >= timeoutMs) {
        fail(run, "El coordinador tardó demasiado");
        continue;
      }
      if (!run.threadId) continue;
      const row = rows.find((r) => r.machineId === run.machineId && r.id === run.threadId);
      if (!row) {
        if (run.seen) fail(run, "El hilo del coordinador desapareció de T3");
        continue;
      }
      run.seen = true;
      const status = taskStatusFor(row, t);
      if (status === "needs_you") fail(run, "El coordinador pidió permiso para usar herramientas; se detuvo sin aprobar nada");
      else if (status === "waiting") fail(run, "El coordinador llegó a su límite de uso");
      else if (status === "failed") fail(run, row.lastError ? `El coordinador falló: ${oneLine(row.lastError, 200)}` : "El coordinador falló");
      else if (status === "cancelled") fail(run, "El hilo del coordinador se detuvo en T3");
      else if (status === "done") reading.push(finish(run));
    }
    return Promise.all(reading).then(() => undefined);
  }

  /** Validates at the boundary, stores a running job and starts it in the background. */
  function create(body: unknown): { job: OrganizeJob; started: Promise<void> } {
    const input = (typeof body === "object" && body !== null ? body : {}) as Partial<Record<keyof OrganizeInput, unknown>>;
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (input.purpose !== undefined && input.purpose !== "assistant" && input.purpose !== "work") throw new HttpError(400, "invalid", "Propósito desconocido");
    const purpose = input.purpose === "assistant" ? "assistant" : "work";
    if (purpose === "assistant" && !deps.assistantContext) throw new HttpError(409, "unavailable", "El asistente no está disponible");
    const history: AssistantMessage[] = [];
    if (input.history !== undefined) {
      if (!Array.isArray(input.history) || input.history.length > 12) throw new HttpError(400, "invalid", "Historial demasiado largo");
      for (const m of input.history) {
        if (!m || typeof m !== "object" || !["user", "assistant"].includes(m.role) || typeof m.text !== "string" || m.text.length > 12000) throw new HttpError(400, "invalid", "Mensaje de historial inválido");
        history.push({ role: m.role, text: m.text });
      }
      if (history.reduce((n, m) => n + m.text.length, 0) > 24000) throw new HttpError(400, "invalid", "Historial demasiado largo");
    }
    if (!text || text.length > MAX_TEXT) throw new HttpError(400, "invalid", `El pedido debe tener entre 1 y ${MAX_TEXT} caracteres`);
    const coordinator = COORDINATORS.find((c) => c.id === input.coordinator)?.id;
    if (!coordinator) throw new HttpError(400, "invalid", "Coordinador desconocido");
    if (input.projectKey != null && typeof input.projectKey !== "string") throw new HttpError(400, "invalid", "projectKey inválido");
    if (input.targetProjectKey != null && (typeof input.targetProjectKey !== "string" || !input.targetProjectKey || !deps.projects().some((p) => `${p.machineId}:${p.id}` === input.targetProjectKey))) throw new HttpError(400, "invalid", "El proyecto elegido no está disponible");
    prune();
    const job: OrganizeJob = { id: newId(), coordinator, status: "running", draft: null, error: null, createdAt: new Date(now()).toISOString() };
    const run: Run = { job, purpose, history, hint: input.projectKey ?? null, targetProjectKey: input.targetProjectKey ?? null, startedAt: now(), machineId: null, threadId: null, seen: false, finishing: false };
    runs.set(job.id, run);
    const started = start(run, text).catch(() => fail(run, "No se pudo iniciar el coordinador"));
    return { job, started };
  }

  function get(id: string): OrganizeJob {
    const run = runs.get(id);
    if (!run) throw new HttpError(404, "not_found", "No se encontró el pedido");
    return run.job;
  }

  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/organize/coordinators",
      auth: "cookie",
      handler: async ({ url }): Promise<Coordinator[]> => (await coordinators(url.searchParams.get("targetProjectKey"))).map((c) => c.coordinator),
    },
    { method: "POST", path: "/api/organize", auth: "cookie", handler: ({ body }) => create(body).job },
    { method: "GET", path: "/api/organize/:id", auth: "cookie", handler: ({ params }) => get(params.id!) },
  ];

  /** True for the coordinator threads "Ordenar con IA" launched: plumbing, not work the user should see. */
  const owns = (machineId: string, threadId: string) => owned.has(`${machineId}:${threadId}`);

  return { routes, advance, create, get, coordinators, owns };
}
