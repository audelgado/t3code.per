import { useEffect, useRef, useState } from "react";
import type { AssistantAction, AssistantMessage, AssistantReply } from "../../server/assistant.ts";
import type { Coordinator, CoordinatorId } from "../../server/organize.ts";
import type { MachineProjects, RuntimeMode } from "../../server/types.ts";
import { call, refresh, useLive } from "./api.ts";
import { DictationTextarea } from "./DictationTextarea.tsx";
import { pollJob } from "./organizeFlow.ts";
import { hashes } from "./navigation.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Select } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

type Message = AssistantMessage & { reply?: AssistantReply };
const actionLabel = (a: AssistantAction) => a.type === "retry" ? "Reintentar tarea" : a.type === "approve" ? "Aprobar tarea" : a.type === "cancel" ? "Cancelar tarea" : "Encolar tarea";

/** Kept mounted when closed so a consultation and its conversation survive closing the popup. */
export function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { view } = useLive();
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [coordinators, setCoordinators] = useState<Coordinator[]>([]);
  const [coordinator, setCoordinator] = useState<CoordinatorId>("codex");
  const [groups, setGroups] = useState<MachineProjects[]>([]);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<RuntimeMode>("auto-accept-edits");
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const controller = useRef<AbortController | null>(null);
  const choice = coordinators.find((c) => c.id === coordinator && c.available) ?? coordinators.find((c) => c.available);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setCoordinators([]);
    call("GET /api/organize/coordinators", { query: target ? { targetProjectKey: target } : undefined }).then((rows) => { if (live) setCoordinators(rows); }, (e) => { if (live) setError(e.message); });
    call("GET /api/projects").then((rows) => { if (live) setGroups(rows); }, (e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [open, target]);
  useEffect(() => () => controller.current?.abort(), []);

  const consult = async (request: string) => {
    if (working.current || listening || !choice || !request.trim()) return;
    working.current = true; setBusy(true); setError(null);
    const history = messages.slice(-8).map(({ role, text }) => ({ role, text: text.slice(0, 2800) }));
    setMessages((prev) => [...prev, { role: "user", text: request }]);
    setText("");
    const ctl = new AbortController(); controller.current = ctl;
    try {
      const first = await call("POST /api/organize", { body: { text: request, purpose: "assistant", history, coordinator: choice.id, targetProjectKey: target || null } });
      const result = await pollJob(first, (id) => call("GET /api/organize/:id", { params: { id } }), { signal: ctl.signal });
      if (result.status !== "done" || !result.reply) throw new Error(result.error ?? "No se pudo consultar al asistente");
      setMessages((prev) => [...prev, { role: "assistant", text: result.reply!.answer, reply: result.reply }]);
    } catch (e) {
      if (!ctl.signal.aborted) { setError(e instanceof Error ? e.message : "No se pudo consultar"); setText(request); }
    } finally { working.current = false; setBusy(false); }
  };

  const apply = async (action: AssistantAction, key: string) => {
    if (working.current || applied.has(key)) return;
    working.current = true; setBusy(true); setError(null);
    try {
      let resultId: string;
      if (action.type === "delegate") {
        const i = action.projectKey.indexOf(":");
        const task = await call("POST /api/tasks", { body: { machineId: action.projectKey.slice(0, i), projectId: action.projectKey.slice(i + 1), title: action.title, prompt: action.prompt, runtimeMode: mode } });
        resultId = task.id;
      } else {
        const params = { id: action.taskId };
        if (action.type === "retry") await call("POST /api/tasks/:id/retry", { params });
        else if (action.type === "cancel") await call("POST /api/tasks/:id/cancel", { params });
        else await call("POST /api/tasks/:id/approve", { params, body: { runtimeMode: mode } });
        resultId = action.taskId;
      }
      setApplied((prev) => new Set([...prev, key]));
      setMessages((prev) => [...prev, { role: "assistant", text: `Acción aplicada: ${actionLabel(action)} — ${action.title}. ID de tarea: ${resultId}. El estado actualizado se ve en Trabajo.` }]);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "La acción no se pudo aplicar. Revisá el estado actual."); await refresh(); }
    finally { working.current = false; setBusy(false); }
  };

  if (!open) return null;
  return <Sheet title="Asistente CC" onClose={onClose} wide footer={<div className="flex flex-wrap gap-2"><Button onClick={onClose}>Cerrar</Button><Button variant="primary" type="submit" form="cc-assistant-form" disabled={busy || listening || !choice || !text.trim()}>Consultar</Button></div>}>
    <div className="grid gap-4">
      <p className="text-sm text-muted-fg">Tu ayudante para administrar el CC: explicar bloqueos, recomendar mejoras y proponer trabajos. Cada consulta usa un agente con el estado actual; las acciones se aplican cuando tocás su botón.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="grid gap-1 text-xs">Dónde consultar<Select aria-label="Dónde consultar al asistente" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}><option value="">Coordinador del CC</option>{groups.map((g) => <optgroup key={g.machineId} label={g.machineLabel}>{g.projects.map((p) => <option key={p.id} value={`${g.machineId}:${p.id}`}>{g.machineLabel} · {p.title}</option>)}</optgroup>)}</Select></label>
        <label className="grid gap-1 text-xs">Agente<Select aria-label="Agente del asistente" value={choice?.id ?? ""} disabled={busy || !coordinators.length} onChange={(e) => setCoordinator(e.target.value as CoordinatorId)}>{!choice && <option value="">Sin agentes disponibles</option>}{coordinators.map((c) => <option key={c.id} value={c.id} disabled={!c.available}>{c.label}{!c.available ? ` · ${c.reason}` : ""}</option>)}</Select></label>
      </div>
      {!!view?.queue.length && <details className="grid gap-2 rounded-ctl border border-line p-3"><summary className="cursor-pointer font-semibold">Estado de tu cola ({view.queue.filter((t) => t.status === "queued").length})</summary>{view.queue.filter((t) => t.status === "queued").slice(0, 8).map((t) => <p key={t.id} className="text-sm"><a className="font-medium text-primary" href={hashes.task(t.id)} onClick={onClose}>{t.title}</a><span className="block text-muted-fg">{t.queueReason ?? "Esperando despacho"}</span></p>)}</details>}
      {!messages.length && <div className="flex flex-wrap gap-2">{["¿Por qué no arrancan mis trabajos?", "¿Qué necesita mi atención?", "Ayudame a delegar un trabajo"].map((prompt) => <Button key={prompt} disabled={busy || listening || !choice} onClick={() => void consult(prompt)}>{prompt}</Button>)}</div>}
      <div className="grid gap-3" aria-live="polite" aria-busy={busy}>{messages.map((m, i) => <article key={i} className={`grid min-w-0 gap-2 rounded-ctl p-3 ${m.role === "user" ? "bg-soft" : "border border-line"}`}><h3 className="text-xs font-semibold text-muted-fg">{m.role === "user" ? "Vos" : "Asistente CC"}</h3><p className="text-sm break-words whitespace-pre-wrap">{m.text}</p>{m.reply?.actions.map((action, j) => {
        const key = `${i}:${j}`;
        return <div key={key} className="grid gap-2 rounded-ctl bg-soft p-3"><strong className="text-sm break-words">{action.title}</strong>{action.type === "delegate" ? <><p className="text-xs text-muted-fg">Proyecto: {groups.flatMap((g) => g.projects.map((p) => ({ key: `${g.machineId}:${p.id}`, label: `${g.machineLabel} · ${p.title}` }))).find((p) => p.key === action.projectKey)?.label ?? action.projectKey}</p><details><summary className="cursor-pointer text-sm">Revisar instrucciones</summary><p className="mt-2 text-sm break-words whitespace-pre-wrap">{action.prompt}</p></details></> : <LinkButton size="sm" href={hashes.task(action.taskId)} onClick={onClose}>Ver tarea</LinkButton>}{action.type === "retry" && <p className="text-xs text-muted-fg">Reinicia este trabajo. Sus dependientes seguirán automáticamente cuando termine bien.</p>}<Button disabled={busy || applied.has(key)} variant={action.type === "cancel" ? "danger" : "primary"} onClick={() => void apply(action, key)}>{applied.has(key) ? "Aplicada" : actionLabel(action)}</Button></div>;
      })}</article>)}</div>
      {messages.some((m) => m.reply?.actions.some((a) => a.type === "delegate" || a.type === "approve")) && <label className="grid gap-1 text-xs">Permisos para aprobar o delegar<Select aria-label="Permisos de tareas propuestas" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as RuntimeMode)}><option value="approval-required">Pedir aprobación</option><option value="auto-accept-edits">Aceptar ediciones</option><option value="full-access">Acceso completo</option></Select></label>}
      {busy && <p role="status" className="text-sm text-muted-fg">Consultando o aplicando la acción… Podés cerrar y volver a abrir el asistente.</p>}
      {error && <p role="alert" className="text-sm text-fail">{error}</p>}
      <form id="cc-assistant-form" onSubmit={(e) => { e.preventDefault(); void consult(text); }}><DictationTextarea aria-label="Mensaje al asistente CC" placeholder="Contame qué pasa o qué querés organizar…" value={text} maxLength={8000} onValueChange={setText} onListeningChange={setListening} disabled={busy} /></form>
    </div>
  </Sheet>;
}
