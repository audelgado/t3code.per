import { CANCEL_TASK_CONFIRMATION } from "./chatConfirm.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantAction } from "../../server/assistant.ts";
import type { AssistantChatView } from "../../server/assistantChat.ts";
import type { Coordinator, CoordinatorId } from "../../server/organize.ts";
import type { MachineProjects, RuntimeMode } from "../../server/types.ts";
import { call, refresh, useLive } from "./api.ts";
import { DictationTextarea } from "./DictationTextarea.tsx";
import { useChatDraft } from "./chatDraftState.ts";
import { useChatFollow } from "./chatFollow.ts";
import { hashes } from "./navigation.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Select } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

const actionLabel = (a: AssistantAction) => a.type === "retry" ? "Reintentar tarea" : a.type === "approve" ? "Aprobar tarea" : a.type === "cancel" ? "Cancelar tarea" : "Encolar tarea";

/** CC restores the conversation and pending sends, including after a reload. */
export function Assistant({ open, onClose, projectKey }: { open: boolean; onClose: () => void; projectKey: string | null }) {
  const { view } = useLive();
  const [chat, setChat] = useState<AssistantChatView | null>(null);
  const [coordinators, setCoordinators] = useState<Coordinator[]>([]);
  const [coordinator, setCoordinator] = useState<CoordinatorId>(() => {
    try { const saved = localStorage.getItem("cc.assistant.coordinator"); return saved === "claude" || saved === "hermes" ? saved : "codex"; } catch { return "codex"; }
  });
  const [groups, setGroups] = useState<MachineProjects[]>([]);
  const [target, setTarget] = useState(projectKey ?? "");
  const [mode, setMode] = useState<RuntimeMode>("auto-accept-edits");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const messages = chat?.messages ?? [];
  const pending = chat?.status === "running";
  const locked = busy || pending || !!chat?.retry;
  const choice = coordinators.find((c) => c.id === coordinator && c.available) ?? coordinators.find((c) => c.available);
  const selectedCoordinator = choice?.id ?? coordinator;
  const selection = { coordinator: selectedCoordinator, projectKey: target || null };
  const selectionKey = JSON.stringify(selection);
  const [text, setText, clearSent, commandId] = useChatDraft(`assistant:${selectionKey}`);
  const { end, away, jump } = useChatFollow(messages.at(-1), selectionKey, open);
  const currentSelection = useRef(selectionKey);
  currentSelection.current = selectionKey;
  const requests = useRef(0);
  const connectivity = view?.machines.filter((m) => !target || target.startsWith(`${m.id}:`)).map((m) => `${m.id}:${m.link.status}`).join("|");
  useEffect(() => { if (choice) { try { localStorage.setItem("cc.assistant.coordinator", choice.id); } catch { /* The server still retains the conversation. */ } } }, [choice?.id]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setCoordinators([]);
    call("GET /api/organize/coordinators", { query: target ? { targetProjectKey: target } : undefined }).then((rows) => { if (live) setCoordinators(rows); }, (e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [open, target, connectivity]);
  useEffect(() => { if (open) call("GET /api/projects").then(setGroups, (e) => setError(e.message)); }, [open]);

  const load = useCallback(async () => {
    const request = ++requests.current;
    try {
      const result = await call("GET /api/assistant", { query: { coordinator: selectedCoordinator, ...(target ? { projectKey: target } : {}) } });
      if (request === requests.current && currentSelection.current === selectionKey) setChat(result);
    } catch (e) { if (request === requests.current && currentSelection.current === selectionKey) setError(e instanceof Error ? e.message : "No se pudo cargar la conversación"); }
  }, [selectedCoordinator, target, selectionKey]);
  useEffect(() => { setChat(null); }, [load]);
  useEffect(() => { if (open) void load(); }, [open, load, view?.assistantVersion]);
  useEffect(() => {
    if (!open) return;
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    // SSE delivers completions; a slow fallback recovers missed reconnect frames.
    const timer = pending ? setInterval(visible, 15000) : undefined;
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [open, pending, load]);

  const consult = async (request: string, sentCommandId: string = commandId) => {
    if (working.current || listening || !choice || !request.trim()) return;
    working.current = true; setBusy(true); setError(null);
    ++requests.current;
    try {
      const result = await call("POST /api/assistant", { body: { ...selection, text: request, commandId: sentCommandId } });
      ++requests.current; setChat(result);
      if (sentCommandId === commandId) clearSent();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo consultar"); await load(); }
    finally { working.current = false; setBusy(false); }
  };

  const apply = async (messageId: string, index: number) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(null);
    ++requests.current;
    try {
      const result = await call("POST /api/assistant/action", { body: { ...selection, messageId, index, runtimeMode: mode } });
      ++requests.current; setChat(result);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "La acción no se pudo aplicar. Revisa el estado actual."); }
    finally { working.current = false; setBusy(false); }
  };
  const queue = view?.queue.filter((t) => !target || `${t.machineId}:${t.projectId}` === target) ?? [];

  if (!open) return null;
  return <Sheet title="Asistente CC" onClose={onClose} wide footer={<form id="cc-assistant-form" className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (!locked) void consult(text); }}>
    <label className="flex min-w-0 items-center gap-3 text-xs text-muted-fg">Alcance<Select className="min-w-0 flex-1" aria-label="Alcance del asistente" value={target} disabled={busy || listening} onChange={(e) => { setTarget(e.target.value); setError(null); }}><option value="">Todo el CC</option>{groups.map((g) => <optgroup key={g.machineId} label={g.machineLabel}>{g.projects.map((p) => <option key={p.id} value={`${g.machineId}:${p.id}`}>Este proyecto: {p.title} · {g.machineLabel}</option>)}</optgroup>)}</Select></label>
    <DictationTextarea compact aria-label="Mensaje al asistente CC" placeholder="Escribe al asistente…" value={text} maxLength={8000} onValueChange={setText} onListeningChange={setListening} disabled={locked || !chat} send={{ busy, disabled: !choice, label: "Enviar al asistente" }} />
  </form>}>
    <div className="grid gap-4">
      {!chat && <p role="status" className="text-sm text-muted-fg">Cargando conversación…</p>}
      {chat && !messages.length && <p className="text-sm text-muted-fg">Consulta tu cola o pide ayuda. La conversación se conserva al volver.</p>}
      <details className="text-sm"><summary className="cursor-pointer text-muted-fg">Ajustes del asistente</summary><label className="mt-2 grid gap-1 text-xs">Agente<Select aria-label="Agente del asistente" value={choice?.id ?? ""} disabled={busy || listening || !coordinators.length} onChange={(e) => setCoordinator(e.target.value as CoordinatorId)}>{!choice && <option value="">Sin agentes disponibles</option>}{coordinators.map((c) => <option key={c.id} value={c.id} disabled={!c.available}>{c.label}{!c.available ? ` · ${c.reason}` : ""}</option>)}</Select></label></details>
      {!!target && <LinkButton size="sm" href={hashes.project(target, "chat")} onClick={onClose}>Abrir chat del proyecto</LinkButton>}
      {!!queue.length && <details className="grid gap-2 rounded-ctl border border-line p-3"><summary className="cursor-pointer font-semibold">Estado de tu cola ({queue.filter((t) => t.status === "queued").length})</summary>{queue.filter((t) => t.status === "queued").slice(0, 8).map((t) => <p key={t.id} className="text-sm"><a className="font-medium text-primary" href={hashes.task(t.id)} onClick={onClose}>{t.title}</a><span className="block text-muted-fg">{t.queueReason ?? "Esperando despacho"}</span></p>)}</details>}
      {chat && !messages.length && <div className="flex flex-wrap gap-2">{["¿Por qué no arrancan mis trabajos?", "¿Qué necesita mi atención?", "Ayúdame a delegar un trabajo"].map((prompt) => <Button key={prompt} disabled={locked || listening || !choice} onClick={() => void consult(prompt)}>{prompt}</Button>)}</div>}
      {away && <div className="sticky top-0 z-10 flex justify-end"><Button onClick={jump}>Volver al final</Button></div>}
      <div className="grid gap-3" aria-live="polite" aria-busy={busy || pending}>{messages.map((m) => <article style={{ contentVisibility: "auto", containIntrinsicSize: "auto 180px" }} key={m.id} aria-label={m.role === "user" ? "Tu mensaje" : "Mensaje del asistente"} className={`grid min-w-0 gap-2 ${m.role === "user" ? "ml-auto max-w-[90%] rounded-2xl bg-soft px-4 py-3" : "py-2"}`}><p className="text-sm break-words whitespace-pre-wrap">{m.text}</p>{m.reply?.actions.map((action, j) => {
        const applied = m.applied?.includes(j);
        return <div key={`${m.id}:${j}`} className="grid gap-2 rounded-ctl bg-soft p-3"><strong className="text-sm break-words">{action.title}</strong>{action.type === "delegate" ? <><p className="text-xs text-muted-fg">Proyecto: {groups.flatMap((g) => g.projects.map((p) => ({ key: `${g.machineId}:${p.id}`, label: `${g.machineLabel} · ${p.title}` }))).find((p) => p.key === action.projectKey)?.label ?? action.projectKey}</p><details><summary className="cursor-pointer text-sm">Revisar instrucciones</summary><p className="mt-2 text-sm break-words whitespace-pre-wrap">{action.prompt}</p></details></> : <LinkButton size="sm" href={hashes.task(action.taskId)} onClick={onClose}>Ver tarea</LinkButton>}{action.type === "retry" && <p className="text-xs text-muted-fg">Reinicia este trabajo. Sus dependientes seguirán automáticamente cuando termine bien.</p>}<Button disabled={locked || applied} variant={action.type === "cancel" ? "danger" : "primary"} onClick={() => { if (action.type !== "cancel" || confirm(CANCEL_TASK_CONFIRMATION)) void apply(m.id, j); }}>{applied ? "Aplicada" : actionLabel(action)}</Button></div>;
      })}</article>)}</div>
      {messages.some((m) => m.reply?.actions.some((a) => a.type === "delegate" || a.type === "approve")) && <label className="grid gap-1 text-xs">Permisos para aprobar o delegar<Select aria-label="Permisos de tareas propuestas" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as RuntimeMode)}><option value="approval-required">Pedir aprobación</option><option value="auto-accept-edits">Aceptar ediciones</option><option value="full-access">Acceso completo</option></Select></label>}
      {(busy || pending) && <p role="status" className="text-sm text-muted-fg">Consultando o aplicando la acción… Puedes cerrar y volver a abrir el asistente.</p>}
      {chat?.retry && <Button disabled={busy} onClick={() => void consult(chat.retry!.text, chat.retry!.commandId)}>Reintentar envío guardado</Button>}
      {(error || chat?.error) && <p role="alert" className="text-sm text-fail">{error ?? chat?.error}</p>}
      <div ref={end} />
    </div>
  </Sheet>;
}
