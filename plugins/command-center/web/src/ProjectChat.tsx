import { STOP_AGENT_CONFIRMATION } from "./chatConfirm.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectChatView } from "../../server/projectChat.ts";
import { call, refresh, useLive } from "./api.ts";
import { ChatHistory } from "./ChatHistory.tsx";
import { DictationTextarea } from "./DictationTextarea.tsx";
import { useChatDraft } from "./chatDraftState.ts";
import { useChatFollow } from "./chatFollow.ts";
import { hashes } from "./navigation.ts";
import { splitProjectKey } from "./projectDirectory.ts";
import { projectChatRevision } from "./projectChatUpdates.ts";
import { ThreadInput } from "./ThreadInput.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";

export function ProjectChat({ projectKey }: { projectKey: string }) {
  return <ProjectChatContent key={projectKey} projectKey={projectKey} />;
}

function ProjectChatContent({ projectKey }: { projectKey: string }) {
  const { machineId, projectId } = splitProjectKey(projectKey);
  const params = { machine: machineId, project: projectId };
  const { view } = useLive();
  const [chat, setChat] = useState<ProjectChatView | null>(null);
  const [text, setText, clearSent] = useChatDraft(`project-chat:${projectKey}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const command = useRef(crypto.randomUUID());
  const sending = useRef(false);
  const fetching = useRef(false);
  const reloadRequested = useRef(false);
  const lastLoaded = useRef(0);
  const { end, away, jump } = useChatFollow(chat?.messages.at(-1), projectKey);
  const active = !!chat && ["preparing", "queued", "starting", "running", "waiting"].includes(chat.status);
  const load = useCallback(async (): Promise<void> => {
    if (fetching.current) { reloadRequested.current = true; return; }
    fetching.current = true;
    try { setChat(await call("GET /api/project-chat/:machine/:project", { params: { machine: machineId, project: projectId } })); setError(null); lastLoaded.current = Date.now(); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo cargar el chat"); }
    finally { fetching.current = false; if (reloadRequested.current) { reloadRequested.current = false; void load(); } }
  }, [machineId, projectId]);
  const revision = projectChatRevision(view, machineId, projectId);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    // Keep streaming as responsive when the shell has no new frame; skip redundant reads after SSE.
    const timer = active ? setInterval(() => { if (!document.hidden && Date.now() - lastLoaded.current >= 3500) void load(); }, 4000) : undefined;
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, load]);
  const act = async (run: () => Promise<unknown>) => {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try { await run(); await load(); void refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo enviar"); }
    finally { sending.current = false; setBusy(false); }
  };
  const pending = chat?.pending;
  const threadParams = { machine: machineId, thread: chat?.threadId ?? "" };
  const tasks = view?.queue.filter((t) => t.machineId === machineId && t.projectId === projectId) ?? [];
  return <section className="mx-auto flex min-h-[55dvh] w-full max-w-3xl flex-col gap-4">
    <div className="flex items-center gap-2 text-xs text-muted-fg"><span className="flex-1">Un chat para coordinar este proyecto</span>{chat?.threadId && <LinkButton size="sm" href={hashes.thread(`${machineId}:${chat.threadId}`)}>Detalles</LinkButton>}</div>
    {!!tasks.length && <details className="rounded-ctl border border-line px-3 py-2"><summary className="cursor-pointer text-sm">Actividad existente · {tasks.length}</summary><div className="mt-2 grid gap-2">{tasks.map((t) => <a key={t.id} href={hashes.task(t.id)} className="text-sm text-primary">{t.title}<span className="block text-xs text-muted-fg">{t.queueReason ?? t.status}</span></a>)}</div></details>}
    {!!chat?.conversations?.length && <details className="text-sm"><summary className="cursor-pointer text-muted-fg">{chat.threadId ? "Otras conversaciones del proyecto" : "Continuar una conversación existente"}</summary><div className="mt-2 grid gap-1">{chat.conversations.filter((c) => c.threadId !== chat.threadId).map((c) => <button key={c.threadId} type="button" disabled={busy} className="rounded-ctl px-3 py-2 text-left hover:bg-soft disabled:opacity-50" onClick={() => void act(() => call("PUT /api/project-chat/:machine/:project", { params, body: { threadId: c.threadId } }))}>{c.title}</button>)}</div></details>}
    {away && <div className="sticky top-2 z-10 flex justify-end"><Button onClick={jump}>Volver al final</Button></div>}
    <div className="min-h-24 flex-1">
      {!chat && !error && <p role="status" className="py-8 text-center text-sm text-muted-fg">Cargando la conversación…</p>}
      {chat && !chat.messages.length && <div className="py-8 text-center"><h2 className="text-lg font-semibold">¿Qué hacemos en este proyecto?</h2><p className="mx-auto mt-2 max-w-sm text-sm text-muted-fg">Escribe o dicta. El orquestador coordina los agentes y reúne sus avances en esta conversación.</p></div>}
      {chat && <ChatHistory messages={chat.messages} />}
      {active && <p role="status" className="mt-4 text-sm text-muted-fg">El orquestador está trabajando. Puedes dejarle el próximo mensaje.</p>}
      <div ref={end} />
    </div>
    {pending && <div className="rounded-ctl border border-line p-3">
      {pending.kind === "user_input" && pending.questions?.length ? <ThreadInput key={pending.id} questions={pending.questions} busy={busy} onSubmit={(answers) => void act(() => call("POST /api/threads/:machine/:thread/answer", { params: threadParams, body: { requestId: pending.id, answers } }))} /> : ["command", "file-read", "file-change", "permission", "mcp-elicitation"].includes(pending.kind) ? <div className="grid gap-3"><p className="text-sm break-words whitespace-pre-wrap">{pending.summary ?? "El agente necesita tu aprobación"}</p><div className="flex gap-2"><Button disabled={busy} onClick={() => void act(() => call("POST /api/threads/:machine/:thread/respond", { params: threadParams, body: { requestId: pending.id, decision: "decline" } }))}>Rechazar</Button><Button variant="primary" disabled={busy} onClick={() => void act(() => call("POST /api/threads/:machine/:thread/respond", { params: threadParams, body: { requestId: pending.id, decision: "accept" } }))}>Aprobar</Button></div></div> : <LinkButton href={hashes.thread(`${machineId}:${chat!.threadId}`)}>Abrir solicitud</LinkButton>}
    </div>}
    {error && <p role="alert" className="text-sm text-fail">{error}</p>}
    {chat?.retry && <Button disabled={busy} onClick={() => void act(() => call("POST /api/project-chat/:machine/:project", { params, body: chat.retry! }))}>Reintentar envío pendiente</Button>}
    <form className="sticky bottom-20 grid gap-2 rounded-card border border-line bg-panel p-3 md:bottom-3" onSubmit={(e) => { e.preventDefault(); if (listening || !text.trim()) return; void act(async () => { await call("POST /api/project-chat/:machine/:project", { params, body: { text, commandId: command.current } }); clearSent(); command.current = crypto.randomUUID(); }); }}>
      <DictationTextarea compact activateEvent={busy || pending || chat?.retry ? undefined : "cc:project-dictate"} aria-label="Mensaje al orquestador" placeholder="Escribe o dicta tu pedido…" rows={2} className="min-h-16" value={text} maxLength={20000} disabled={busy || !!pending || !!chat?.retry} onValueChange={(v) => { setText(v); command.current = crypto.randomUUID(); }} onListeningChange={setListening} />
      <div className="flex justify-end gap-2">{active && chat?.threadId && <Button disabled={busy} onClick={() => { if (confirm(STOP_AGENT_CONFIRMATION)) void act(() => call("POST /api/threads/:machine/:thread/stop", { params: threadParams })); }}>Detener agente</Button>}<Button type="submit" variant="primary" disabled={busy || listening || !!pending || !!chat?.retry || !text.trim()}>{active ? "Enviar después" : "Enviar"}</Button></div>
    </form>
  </section>;
}
