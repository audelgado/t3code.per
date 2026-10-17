import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getProject, kvGet, kvSet } from "./db.ts";
import { HttpError, type Route } from "./http.ts";
import type { ChatMessage, LaunchInput, ModelSelection, PendingRequest, RuntimeMode, T3Link, ThreadRow, ThreadStatus } from "./types.ts";

interface Conversation { launch: LaunchInput; firstText: string; pendingLaunch: boolean }
export interface ProjectChatView { threadId: string | null; status: ThreadStatus; messages: ChatMessage[]; pending: PendingRequest | null; retry?: { commandId: string; text: string }; conversations?: { threadId: string; title: string; status: ThreadStatus }[] }
interface ChatInput { text: string; commandId: string; model?: ModelSelection; runtimeMode?: RuntimeMode }
declare module "./types.ts" { interface Api {
  "GET /api/project-chat/:machine/:project": { body: never; res: ProjectChatView };
  "POST /api/project-chat/:machine/:project": { body: ChatInput; res: { threadId: string } };
  "PUT /api/project-chat/:machine/:project": { body: { threadId: string }; res: { threadId: string } };
} }

/** One durable T3 orchestrator thread per project. T3 owns messages, queueing and delegated children. */
export function createProjectChat(deps: { db: DatabaseSync; link: (id: string) => T3Link | undefined; threads: () => ThreadRow[]; activity: (machine: string, project: string) => unknown }) {
  const locks = new Set<string>();
  const key = (machine: string, project: string) => `project-chat:${machine}:${project}`;
  const record = (machine: string, project: string) => kvGet<Conversation>(deps.db, key(machine, project));
  function target(machine: string, project: string) {
    const entry = getProject(deps.db, machine, project);
    if (!entry) throw new HttpError(404, "not_found", "No se encontró el proyecto");
    const link = deps.link(machine);
    if (link?.state.status !== "online") throw new HttpError(503, "offline", "El sistema está desconectado. Tu borrador sigue aquí.");
    return { entry, link };
  }
  async function read(machine: string, project: string): Promise<ProjectChatView> {
    if (!getProject(deps.db, machine, project)) throw new HttpError(404, "not_found", "No se encontró el proyecto");
    const c = record(machine, project);
    const conversations = deps.threads().filter((r) => r.machineId === machine && r.projectId === project && r.relationshipToParent !== "subagent").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20).map((r) => ({ threadId: r.id, title: r.title, status: r.status }));
    if (!c) return { threadId: null, status: "idle", messages: [], pending: null, conversations };
    const { link } = target(machine, project);
    const row = deps.threads().find((r) => r.machineId === machine && r.id === c.launch.threadId);
    const retry = c.pendingLaunch ? { commandId: c.launch.commandId, text: c.firstText } : undefined;
    if (!row && c.pendingLaunch) return { threadId: c.launch.threadId, status: "starting", messages: [{ id: c.launch.commandId, role: "user", text: c.firstText, createdAt: "", streaming: false }], pending: null, retry };
    const result = await link.readResult(c.launch.threadId);
    const messages = (result.messages ?? []).map((m) => m.role === "user" && m.text.length > 100 && c.launch.prompt.startsWith(m.text) ? { ...m, text: c.firstText } : m);
    return { threadId: c.launch.threadId, status: row?.status ?? "idle", messages, pending: result.pending, conversations, retry };
  }
  async function send(machine: string, project: string, raw: unknown) {
    const input = (raw ?? {}) as Partial<ChatInput>;
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 20000 || typeof input.commandId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.commandId)) throw new HttpError(400, "invalid", "Escribe un mensaje de hasta 20000 caracteres");
    if (input.runtimeMode !== undefined && !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(input.runtimeMode)) throw new HttpError(400, "invalid", "Permisos inválidos");
    const k = key(machine, project);
    if (locks.has(k)) throw new HttpError(409, "busy", "Se está enviando un mensaje; prueba de nuevo");
    const { entry, link } = target(machine, project);
    locks.add(k);
    try {
      let c = record(machine, project);
      if (!c) {
        const providers = await link.providers();
        const model = input.model ?? entry.defaultModel ?? providers.filter((p) => p.enabled && p.installed).flatMap((p) => p.models.map((m) => ({ instanceId: p.instanceId, model: m.slug })))[0];
        if (!model || !providers.some((p) => p.enabled && p.installed && p.instanceId === model.instanceId && p.models.some((m) => m.slug === model.model))) throw new HttpError(409, "model", "Elige un agente disponible en Ajustes");
        const prompt = [
          "Usa español neutro. Evita el voseo y los regionalismos.",
          "Eres el orquestador de este proyecto dentro de Command Center. Este es el único chat principal para coordinar sus trabajos: conversa naturalmente, mantén el contexto y consolida resultados aquí.",
          "Para trabajo que requiera un equipo usa la orquestación nativa de T3: consulta orchestrator_capabilities y delega con delegate_task, o las herramientas nativas compatibles. Los agentes son hijos de ESTE hilo; no crees conversaciones top-level para repartir trabajo. Respeta dependencias, revisa resultados y comunicá avances en este chat. No delegues para responder una pregunta simple.",
          "Conserva mains y trabajo existente. Si una implementación necesita aislamiento usa isolation:worktree o el mecanismo oficial de T3. Las tareas anteriores del CC siguen su propio despachador: no las vuelvas a ejecutar ni declares que las cambiaste. Si hay trabajos activos que pisan el mismo código, coordina antes de editar.",
          `Proyecto: ${entry.title}. Actividad existente al iniciar: ${JSON.stringify(deps.activity(machine, project))}`,
          "Pedido del usuario:", input.text.trim(),
        ].join("\n\n");
        c = { firstText: input.text.trim(), pendingLaunch: true, launch: { commandId: input.commandId, threadId: randomUUID(), projectId: project, title: `Chat · ${entry.title}`.slice(0, 80), modelSelection: model, runtimeMode: input.runtimeMode ?? "auto-accept-edits", interactionMode: "default", workspaceStrategy: { type: "root" }, prompt } };
        kvSet(deps.db, k, c);
      }
      if (c.launch.commandId === input.commandId) {
        if (c.pendingLaunch) { await link.launch(c.launch); c.pendingLaunch = false; kvSet(deps.db, k, c); }
      } else {
        if (c.pendingLaunch) throw new HttpError(409, "pending", "El primer envío no se confirmó. Vuelve a intentar ese mensaje antes de continuar.");
        if (!link.sendMessage) throw new HttpError(409, "unsupported", "Este sistema no admite mensajes");
        const row = deps.threads().find((r) => r.machineId === machine && r.id === c.launch.threadId);
        if (row?.pendingRequest) throw new HttpError(409, "pending", "Responde la solicitud pendiente en el chat");
        await link.sendMessage(c.launch.threadId, input.text.trim(), input.commandId, "queue_after_active");
      }
      return { threadId: c.launch.threadId };
    } finally { locks.delete(k); }
  }
  function bind(machine: string, project: string, id: unknown) {
      target(machine, project);
      const row = deps.threads().find((r) => r.machineId === machine && r.projectId === project && r.id === id && r.relationshipToParent !== "subagent");
      if (!row) throw new HttpError(404, "not_found", "La conversación no pertenece a este proyecto");
      if (locks.has(key(machine, project))) throw new HttpError(409, "busy", "Espera a que termine el envío");
      const old = record(machine, project);
      if (old?.pendingLaunch) throw new HttpError(409, "pending", "Confirma primero el envío pendiente");
      const current = old && deps.threads().find((r) => r.machineId === machine && r.id === old.launch.threadId);
      if (current?.activeRunId && current.id !== row.id) throw new HttpError(409, "busy", "Detén el agente actual antes de cambiar de conversación");
      kvSet(deps.db, key(machine, project), { pendingLaunch: false, firstText: "", launch: { commandId: randomUUID(), threadId: row.id, projectId: project, title: row.title, prompt: "", modelSelection: { instanceId: row.providerInstanceId ?? "", model: "" }, runtimeMode: "auto-accept-edits", interactionMode: "default", workspaceStrategy: { type: "root" } } } satisfies Conversation);
      return { threadId: row.id };
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/project-chat/:machine/:project", auth: "cookie", handler: ({ params }) => read(params.machine!, params.project!) },
    { method: "POST", path: "/api/project-chat/:machine/:project", auth: "cookie", handler: ({ params, body }) => send(params.machine!, params.project!, body) },
    { method: "PUT", path: "/api/project-chat/:machine/:project", auth: "cookie", handler: ({ params, body }) => bind(params.machine!, params.project!, (body as { threadId?: unknown } | null)?.threadId) },
  ];
  return { routes, read, send, bind };
}
