import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { assistantPrompt, assistantState, parseAssistantReply, scopeAssistantContext, type AssistantContext, type AssistantMessage, type AssistantReply } from "./assistant.ts";
import { kvGet, kvSet } from "./db.ts";
import { HttpError, type Route } from "./http.ts";
import type { createOrganize, CoordinatorId } from "./organize.ts";
import { T3Error, type LaunchInput, type RuntimeMode, type T3Link, type ThreadRow } from "./types.ts";

export interface AssistantChatMessage extends AssistantMessage { id: string; reply?: AssistantReply; applied?: number[] }
export interface AssistantChatView { messages: AssistantChatMessage[]; status: "idle" | "running" | "failed"; error: string | null; retry?: { text: string; commandId: string } }
interface Selection { coordinator: CoordinatorId; projectKey?: string | null }
interface SendInput extends Selection { text: string; commandId: string }
interface Turn { commandId: string; text: string; prompt: string; snapshot: string; receipts: string[]; baseline: string | null; updatedAt: string | null; sent: boolean; startedAt: number; launch?: LaunchInput }
interface Conversation extends Selection { machineId: string; threadId: string; messages: AssistantChatMessage[]; receipts: string[]; snapshot: string | null; turn: Turn | null; rejectedLaunch?: LaunchInput; status: AssistantChatView["status"]; error: string | null }

declare module "./types.ts" { interface Api {
  "GET /api/assistant": { body: never; res: AssistantChatView };
  "POST /api/assistant": { body: SendInput; res: AssistantChatView };
  "POST /api/assistant/action": { body: Selection & { messageId: string; index: number; runtimeMode: RuntimeMode }; res: AssistantChatView };
} }

/** CC stores the display history and delivery intent; T3 owns the provider conversation. */
export function createAssistantChat(deps: {
  db: DatabaseSync; context: () => AssistantContext;
  coordinators: ReturnType<typeof createOrganize>["coordinators"];
  link: (id: string) => T3Link | undefined; threads: () => ThreadRow[];
  apply: (action: NonNullable<AssistantReply>["actions"][number], mode: RuntimeMode) => Promise<string>;
  onChange?: () => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const saved = kvGet<Record<string, Conversation>>(deps.db, "assistant-chats") ?? {};
  const locks = new Set<string>();
  const owned = new Set(Object.values(saved).map((c) => `${c.machineId}:${c.threadId}`));
  const persist = () => { kvSet(deps.db, "assistant-chats", saved); deps.onChange?.(); };
  const key = (s: Selection) => JSON.stringify([s.coordinator, s.projectKey ?? null]);
  const context = (s: Selection) => scopeAssistantContext(deps.context(), s.projectKey);
  function selection(raw: Selection): Selection {
    if (!["codex", "claude", "hermes"].includes(raw.coordinator)) throw new HttpError(400, "invalid", "Elige un agente disponible");
    if (raw.projectKey != null && (typeof raw.projectKey !== "string" || !deps.context().projects.some((p) => `${p.machineId}:${p.id}` === raw.projectKey))) throw new HttpError(400, "invalid", "El proyecto elegido no está disponible");
    return { coordinator: raw.coordinator, projectKey: raw.projectKey ?? null };
  }
  function view(c?: Conversation): AssistantChatView {
    return { messages: c?.messages ?? [], status: c?.status ?? "idle", error: c?.error ?? null,
      ...(c?.turn && !c.turn.sent ? { retry: { text: c.turn.text, commandId: c.turn.commandId } } : {}) };
  }
  function fail(c: Conversation, error: string) {
    c.status = "failed"; c.error = error; c.turn = null; persist();
  }
  async function deliver(c: Conversation) {
    const turn = c.turn;
    if (!turn || turn.sent) return;
    const link = deps.link(c.machineId);
    if (link?.state.status !== "online") throw new HttpError(503, "offline", "El sistema está desconectado. El mensaje sigue guardado.");
    if (turn.launch) await link.launch(turn.launch);
    else {
      if (!link.sendMessage) throw new HttpError(409, "unsupported", "Este sistema no admite continuar conversaciones");
      await link.sendMessage(c.threadId, turn.prompt, turn.commandId, "queue_after_active");
    }
    turn.sent = true; c.rejectedLaunch = undefined; c.snapshot = turn.snapshot; c.receipts = c.receipts.filter((r) => !turn.receipts.includes(r)); c.error = null; persist();
  }
  async function transmit(c: Conversation) {
    try { await deliver(c); } catch (e) {
      if (e instanceof T3Error) {
        c.rejectedLaunch = c.turn?.launch;
        fail(c, "T3 rechazó el envío. Revisa la conexión y los permisos antes de volver a consultar.");
        return;
      }
      c.error = "No se confirmó el envío. Reintenta el mensaje guardado para evitar duplicados."; persist(); throw e;
    }
  }
  async function advanceOne(c: Conversation) {
    const turn = c.turn;
    if (!turn?.sent || c.status !== "running") return;
    const link = deps.link(c.machineId);
    if (link?.state.status !== "online") return;
    const row = deps.threads().find((r) => r.machineId === c.machineId && r.id === c.threadId);
    // Pending approvals belong to this assistant; never accept tool use automatically.
    if (row?.pendingRequest) {
      if (row.activeRunId) await link.interrupt(c.threadId, row.activeRunId);
      fail(c, "El asistente pidió usar herramientas. Se detuvo sin aprobar nada."); return;
    }
    if (row?.activeRunId || ["running", "starting", "queued", "preparing"].includes(row?.status ?? "")) return;
    if (row && row.updatedAt !== turn.updatedAt && ["failed", "cancelled", "interrupted", "rolled_back"].includes(row.status)) { fail(c, "La consulta se detuvo en T3. Puedes volver a intentarlo."); return; }
    // A newly created or reconnecting thread can expose commentary before its terminal shell row.
    if (row?.status !== "completed") return;
    const result = await link.readResult(c.threadId);
    const last = result.messages?.findLast((m) => m.role === "assistant");
    if (last && last.id !== turn.baseline && !last.streaming) {
      const reply = parseAssistantReply(last.text, context(c));
      if (!reply) { fail(c, "El asistente no devolvió una respuesta válida. Puedes volver a intentarlo."); return; }
      c.messages.push({ id: last.id, role: "assistant", text: reply.answer, reply });
      c.messages = c.messages.slice(-60); c.turn = null; c.status = "idle"; c.error = null; persist();
      return;
    }
    if (now() - turn.startedAt > 150_000) {
      // Do not invite a duplicate turn while the original can still be running.
      const error = "La respuesta está tardando. La consulta sigue guardada; vuelve a abrir el asistente para ver su estado.";
      if (c.error !== error) { c.error = error; persist(); }
    }
  }
  async function exclusive<T>(k: string, fn: () => Promise<T>) {
    if (locks.has(k)) throw new HttpError(409, "busy", "Espera a que termine la operación actual");
    locks.add(k); try { return await fn(); } finally { locks.delete(k); }
  }
  async function read(raw: Selection) {
    const s = selection(raw); const k = key(s); const c = saved[k];
    if (c && !locks.has(k)) await exclusive(k, () => advanceOne(c));
    return view(c);
  }
  async function send(raw: SendInput) {
    const s = selection(raw); const k = key(s);
    if (typeof raw.text !== "string" || !raw.text.trim() || raw.text.length > 8000 || typeof raw.commandId !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.commandId)) throw new HttpError(400, "invalid", "Escribe un mensaje de hasta 8000 caracteres");
    return exclusive(k, async () => {
      let c = saved[k];
      const previous = c?.messages.find((m) => m.id === raw.commandId);
      if (c && previous) {
        if (previous.text !== raw.text.trim()) throw new HttpError(409, "conflict", "El identificador de envío corresponde a otro mensaje");
        if (c.turn?.commandId === raw.commandId) await transmit(c);
        return view(c);
      }
      if (c?.turn) throw new HttpError(409, "busy", "Espera la respuesta pendiente antes de enviar otro mensaje");
      const text = raw.text.trim();
      const snapshot = JSON.stringify(assistantState(context(s)));
      if (!c) {
        const entry = (await deps.coordinators(s.projectKey)).find((e) => e.coordinator.id === s.coordinator);
        if (!entry?.provider || !entry.target) throw new HttpError(409, "unavailable", entry?.coordinator.reason ?? "El agente no está disponible");
        const model = entry.provider.models.find((m) => m.isDefault) ?? entry.provider.models[0]!;
        const prompt = assistantPrompt(text, [], context(s));
        const threadId = randomUUID();
        c = { ...s, machineId: entry.target.machine.id, threadId, messages: [], receipts: [], snapshot: null, status: "running", error: null,
          turn: { commandId: raw.commandId, text, prompt, snapshot, receipts: [], baseline: null, updatedAt: null, sent: false, startedAt: now(),
            launch: { commandId: raw.commandId, threadId, projectId: entry.target.projectId, title: s.projectKey ? "Asistente CC · Proyecto" : "Asistente CC · General", modelSelection: { instanceId: entry.provider.instanceId, model: model.slug }, runtimeMode: "approval-required", interactionMode: "default", workspaceStrategy: { type: "root" }, prompt } } };
        saved[k] = c; owned.add(`${c.machineId}:${threadId}`);
      } else if (c.rejectedLaunch) {
        // A definitive launch rejection has no provider conversation to continue.
        const prompt = assistantPrompt(text, [], context(s));
        c.turn = { commandId: raw.commandId, text, prompt, snapshot, receipts: [], baseline: null, updatedAt: null, sent: false, startedAt: now(), launch: { ...c.rejectedLaunch, commandId: raw.commandId, prompt } };
        c.status = "running"; c.error = null;
      } else {
        const link = deps.link(c.machineId);
        if (link?.state.status !== "online") throw new HttpError(503, "offline", "El sistema está desconectado. Conserva tu borrador.");
        const result = await link.readResult(c.threadId);
        if (!result.messages) throw new HttpError(409, "unsupported", "Este sistema no permite recuperar el historial del asistente");
        const { machineId, threadId } = c;
        const row = deps.threads().find((r) => r.machineId === machineId && r.id === threadId);
        const state = snapshot === c.snapshot ? "Estado operativo sin cambios desde el mensaje anterior." : `Estado actual (sustituye el anterior; muestra acotada):\n${snapshot}`;
        const receipts = c.receipts.length ? `\n\nResultados de acciones confirmadas por el CC:\n${JSON.stringify(c.receipts)}` : "";
        const prompt = `${state}${receipts}\n\nPedido actual:\n${JSON.stringify(text)}`;
        c.turn = { commandId: raw.commandId, text, prompt, snapshot, receipts: [...c.receipts], baseline: result.messages?.findLast((m) => m.role === "assistant")?.id ?? null, updatedAt: row?.updatedAt ?? null, sent: false, startedAt: now() };
        c.status = "running"; c.error = null;
      }
      c.messages.push({ id: raw.commandId, role: "user", text }); c.messages = c.messages.slice(-60); persist();
      await transmit(c);
      return view(c);
    });
  }
  async function apply(raw: Selection & { messageId: string; index: number; runtimeMode: RuntimeMode }) {
    const s = selection(raw); const k = key(s);
    if (!["approval-required", "auto-accept-edits", "auto", "full-access"].includes(raw.runtimeMode)) throw new HttpError(400, "invalid", "Elige los permisos de la tarea");
    return exclusive(k, async () => {
      const c = saved[k]; const m = c?.messages.find((m) => m.id === raw.messageId);
      const action = m?.reply?.actions[raw.index];
      if (!c || !m || !action || !Number.isInteger(raw.index)) throw new HttpError(404, "not_found", "La propuesta ya no está disponible");
      if (m.applied?.includes(raw.index)) return view(c);
      if (!parseAssistantReply(JSON.stringify({ answer: "Validar", actions: [action] }), context(c))?.actions.length) throw new HttpError(409, "stale", "El estado cambió. Consulta de nuevo antes de aplicar esta propuesta.");
      const id = await deps.apply(action, raw.runtimeMode);
      m.applied = [...m.applied ?? [], raw.index];
      const receipt = `Acción aplicada: ${action.title}. ID de tarea: ${id}.`;
      c.receipts.push(receipt);
      c.messages.push({ id: randomUUID(), role: "assistant", text: receipt }); c.messages = c.messages.slice(-60); persist();
      return view(c);
    });
  }
  async function advance() {
    await Promise.allSettled(Object.entries(saved).filter(([k, c]) => c.turn?.sent && !locks.has(k)).map(([k, c]) => exclusive(k, () => advanceOne(c))));
  }
  const fromQuery = (url: URL) => ({ coordinator: (url.searchParams.get("coordinator") ?? "codex") as CoordinatorId, projectKey: url.searchParams.get("projectKey") });
  const routes: Route[] = [
    { method: "GET", path: "/api/assistant", auth: "cookie", handler: ({ url }) => read(fromQuery(url)) },
    { method: "POST", path: "/api/assistant", auth: "cookie", handler: ({ body }) => send((body ?? {}) as SendInput) },
    { method: "POST", path: "/api/assistant/action", auth: "cookie", handler: ({ body }) => apply((body ?? {}) as Parameters<typeof apply>[0]) },
  ];
  return { routes, read, send, apply, advance, owns: (machine: string, thread: string) => owned.has(`${machine}:${thread}`) };
}
