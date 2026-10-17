// Thread actions from the phone: read a result, answer an approval, stop a run, settle a thread.
// Wire-up: `routes.push(...threadRoutes({ links: (id) => links.get(id)?.link, threads: () => dispatcher.threads() }))`.
import { HttpError, type Route } from "./http.ts";
import { T3Error, type ApprovalDecision, type PendingRequest, type T3Link, type ThreadRow, type ThreadStatus } from "./types.ts";
import { validateThreadAnswers } from "./threadAnswers.ts";

/** Approval decisions are separate from structured user-input answers. */
const APPROVAL_KINDS = new Set(["command", "file-read", "file-change", "permission"]);
const DECISIONS = new Set<string>(["accept", "acceptForSession", "decline"] satisfies ApprovalDecision[]);

export interface ThreadDetail {
  messages?: import("./types.ts").ChatMessage[];
  status: ThreadStatus;
  /** Last assistant text, up to 4000 chars. */
  text: string | null;
  pending: PendingRequest | null;
  /** True when `pending` is an approval the CC can answer. */
  answerable: boolean;
  inputAnswerable: boolean;
  canMessage: boolean;
}

/** Type contract for the web (merge into Api when wiring). */
export interface ThreadActionApi {
  "GET /api/threads/:machine/:thread": { body: never; res: ThreadDetail };
  "POST /api/threads/:machine/:thread/respond": { body: { requestId: string; decision: ApprovalDecision }; res: { ok: true } };
  "POST /api/threads/:machine/:thread/stop": { body: never; res: { ok: true } };
  "POST /api/threads/:machine/:thread/settle": { body: never; res: { ok: true } };
  "POST /api/threads/:machine/:thread/answer": { body: { requestId: string; answers: import("./types.ts").UserInputAnswers }; res: { ok: true } };
  "POST /api/threads/:machine/:thread/message": { body: { text: string; commandId: string }; res: { ok: true } };
}

export interface ThreadActionDeps {
  links(machineId: string): T3Link | undefined;
  threads(): ThreadRow[];
}

declare module "./types.ts" { interface Api extends ThreadActionApi {} }

export function threadRoutes(deps: ThreadActionDeps): Route[] {
  /** The live row plus an online link, or the HTTP error to answer. */
  function target(params: Record<string, string>): { row: ThreadRow; link: T3Link } {
    const row = deps.threads().find((r) => r.machineId === params.machine && r.id === params.thread);
    if (!row) throw new HttpError(404, "not_found", "Thread not found");
    const link = deps.links(row.machineId);
    if (link?.state.status !== "online") throw new HttpError(503, "offline", "Machine is offline");
    return { row, link };
  }
  const t3 = <T>(p: Promise<T>) => p.catch((e: unknown) => Promise.reject(e instanceof T3Error ? new HttpError(502, "t3_error", e.message) : e));
  const action = (path: string, run: (ctx: { row: ThreadRow; link: T3Link; body: unknown }) => Promise<void>): Route => ({
    method: "POST",
    path: `/api/threads/:machine/:thread/${path}`,
    auth: "cookie",
    handler: async ({ params, body }) => {
      const { row, link } = target(params);
      await t3(run({ row, link, body }));
      return { ok: true };
    },
  });

  return [
    {
      method: "GET",
      path: "/api/threads/:machine/:thread",
      auth: "cookie",
      handler: async ({ params }): Promise<ThreadDetail> => {
        const { row, link } = target(params);
        const { text, pending, messages } = await t3(link.readResult(row.id));
        // The shell row is fresher for the request id; readResult adds the summary.
        const live = row.pendingRequest && (pending?.id === row.pendingRequest.id ? pending : row.pendingRequest);
        return { status: row.status, messages, text: text?.slice(0, 4000) ?? null, pending: live ?? null, answerable: live ? APPROVAL_KINDS.has(live.kind) : false,
          inputAnswerable: live?.kind === "user_input" && !!live.questions?.length && !!link.answerInput,
          canMessage: !live && !row.activeRunId && !["preparing", "queued", "starting", "running", "waiting"].includes(row.status) && !!link.sendMessage };
      },
    },
    action("respond", async ({ row, link, body }) => {
      const { requestId, decision } = (body ?? {}) as { requestId?: unknown; decision?: unknown };
      if (typeof requestId !== "string" || typeof decision !== "string" || !DECISIONS.has(decision))
        throw new HttpError(400, "bad_request", "requestId and decision (accept, acceptForSession, decline) required");
      const pending = row.pendingRequest;
      if (!pending || pending.id !== requestId) throw new HttpError(409, "stale", "That request is no longer pending");
      if (!APPROVAL_KINDS.has(pending.kind)) throw new HttpError(409, "unsupported", "Open in T3 to answer this request");
      await link.respond(row.id, requestId, decision as ApprovalDecision);
    }),
    action("answer", async ({ row, link, body }) => {
      const input = (body ?? {}) as { requestId?: unknown; answers?: unknown };
      if (typeof input.requestId !== "string") throw new HttpError(400, "bad_request", "requestId requerido");
      if (row.pendingRequest?.id !== input.requestId) throw new HttpError(409, "stale", "La pregunta ya no está pendiente; actualizá el detalle");
      if (row.pendingRequest.kind !== "user_input" || !link.answerInput) throw new HttpError(409, "unsupported", "Esta solicitud no admite respuestas de texto");
      const fresh = await link.readResult(row.id);
      if (fresh.pending?.id !== input.requestId || !fresh.pending.questions?.length) throw new HttpError(409, "stale", "Las preguntas cambiaron; actualizá el detalle");
      let answers;
      try { answers = validateThreadAnswers(fresh.pending.questions, input.answers); }
      catch (e) { throw new HttpError(400, "bad_request", e instanceof Error ? e.message : "Respuesta inválida"); }
      await link.answerInput(row.id, input.requestId, answers);
    }),
    action("message", async ({ row, link, body }) => {
      const { text, commandId } = (body ?? {}) as { text?: unknown; commandId?: unknown };
      if (typeof text !== "string" || !text.trim() || text.length > 20000 || typeof commandId !== "string" || !/^[0-9a-f-]{36}$/i.test(commandId)) throw new HttpError(400, "bad_request", "Escribí un mensaje de hasta 20000 caracteres");
      if (row.pendingRequest || row.activeRunId || ["preparing", "queued", "starting", "running", "waiting"].includes(row.status)) throw new HttpError(409, "busy", "El agente sigue trabajando o espera una respuesta al formulario");
      if (!link.sendMessage) throw new HttpError(409, "unsupported", "El sistema no admite mensajes");
      await link.sendMessage(row.id, text.trim(), commandId);
    }),
    action("stop", async ({ row, link }) => {
      if (!row.activeRunId) throw new HttpError(409, "no_run", "No run is active");
      await link.interrupt(row.id, row.activeRunId);
    }),
    action("settle", ({ row, link }) => link.settle(row.id)),
  ];
}
