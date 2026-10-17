import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HomeView, ThreadItem } from "../../server/types.ts";
import type { ThreadActionApi, ThreadDetail } from "../../server/threadActions.ts";
import { call } from "./api.ts";
import { planSteps, requestKindLabel, threadReason, type ThreadReason } from "./homeQueueView.ts";
import { ago, at } from "./look.ts";
import { hashes } from "./navigation.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Chip, StatusChip } from "./ui/Chip.tsx";
import { useAct, useProjectTitles } from "./workData.ts";
import { ErrorNote, ProjectTag } from "./workUi.tsx";
import { ChatHistory } from "./ChatHistory.tsx";
import { ThreadInput } from "./ThreadInput.tsx";
import { DictationTextarea } from "./DictationTextarea.tsx";

// ponytail: typed through this cast until the routes are merged into Api (server/types.ts).
const api = call as unknown as <R extends keyof ThreadActionApi>(
  route: R,
  opts: { params: Record<string, string>; body?: ThreadActionApi[R]["body"] },
) => Promise<ThreadActionApi[R]["res"]>;

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const TITLE: Record<ThreadReason, string> = { approval: "Aprobación", input: "Pregunta", plan: "Plan" };
const CHIP: Record<ThreadReason, string> = { approval: "Aprobación", input: "Pregunta", plan: "Revisar plan" };

/** The approval overlay's frame: a bottom sheet on the phone, a centred modal on desktop. Escape or the backdrop closes it. */
function Overlay({ label, header, footer, onClose, children }: { label: string; header: ReactNode; footer: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-fg/30 md:items-start md:p-6 md:pt-[8vh]" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-[620px] flex-col overflow-hidden rounded-t-[22px] border border-line bg-panel shadow-[0_-10px_40px_rgba(0,0,0,.2)] outline-none md:max-h-[84dvh] md:rounded-2xl md:shadow-[0_24px_64px_rgba(0,0,0,.28)]"
      >
        <div aria-hidden className="mx-auto mt-2 mb-1 h-[5px] w-10 shrink-0 rounded-full bg-[#d6d3cc] md:hidden" />
        <header className="flex shrink-0 items-center gap-1 border-b-0 px-4 pt-2 pb-2 md:border-b md:border-line md:py-3">{header}</header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-4">{children}</div>
        <div className="shrink-0 border-t border-line bg-panel px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>
      </div>
    </div>
  );
}

/** Thread detail with the actions that fit its state: approve or decline, review a plan, stop, settle. Opens from `#item=<key>`. */
export function ThreadSheet(props: { item: ThreadItem; view: HomeView; onClose: () => void }) {
  // Keyed so moving to the next approval starts from a clean fetch and clean errors.
  return <Thread key={props.item.key} {...props} />;
}

function Thread({ item, view, onClose }: { item: ThreadItem; view: HomeView; onClose: () => void }) {
  const machine = view.machines.find((m) => m.id === item.machineId)?.label ?? item.machineId;
  const titles = useProjectTitles();
  const projectKey = `${item.machineId}:${item.projectId}`;
  const params = { machine: item.machineId, thread: item.threadId };
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const { busy, error, act } = useAct();
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState("");
  const messageCommand = useRef(crypto.randomUUID());

  // Fetched on open (not in the view): the result text is read from T3 once per tap.
  useEffect(() => {
    let live = true;
    api("GET /api/threads/:machine/:thread", { params }).then(
      (d) => live && setDetail(d),
      (e: unknown) => live && setLoadError(e instanceof Error ? e.message : "Error desconocido"),
    );
    return () => void (live = false);
  }, [item.machineId, item.threadId, item.pending?.id]);

  // Approvals and plans waiting on you, oldest first: what the arrows walk through.
  const queue = useMemo(
    () => view.needsYou.flatMap((n) => (n.kind === "thread" ? [n] : [])).sort((a, b) => a.since.localeCompare(b.since)).map((n) => n.thread.key),
    [view.needsYou],
  );
  const at0 = queue.indexOf(item.key);
  const go = (to: number) => location.replace(hashes.thread(queue[to]!));

  const pending = detail ? detail.pending : item.pending;
  const text = detail?.text ?? item.preview;
  const reason = threadReason({ pending, planReady: item.planReady });
  const running = ACTIVE.has(item.status);
  const steps = reason === "plan" ? planSteps(text) : null;
  const respond = (decision: "accept" | "acceptForSession" | "decline") =>
    void act("No se pudo responder", async () => {
      await api("POST /api/threads/:machine/:thread/respond", { params, body: { requestId: pending!.id, decision } });
      onClose();
    });
  const answerable = !!pending && !!detail?.answerable;

  const header = (
    <>
      <h2 className="text-base font-semibold">{reason ? TITLE[reason] : "Hilo"}</h2>
      {at0 >= 0 && <span className="text-[13px] text-muted-fg">· {at0 + 1} de {queue.length}</span>}
      <span className="ml-auto flex items-center">
        {at0 >= 0 && queue.length > 1 && (
          <>
            <Button variant="ghost" size="icon" aria-label="Anterior" disabled={at0 === 0} onClick={() => go(at0 - 1)}><ChevronLeft className="size-4" aria-hidden /></Button>
            <Button variant="ghost" size="icon" aria-label="Siguiente" disabled={at0 === queue.length - 1} onClick={() => go(at0 + 1)}><ChevronRight className="size-4" aria-hidden /></Button>
          </>
        )}
        <Button variant="ghost" size="icon" aria-label="Cerrar" onClick={onClose}><X className="size-4" aria-hidden /></Button>
      </span>
    </>
  );

  const footer = (
    <div className="grid gap-2">
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex flex-wrap items-center gap-2">
        {answerable && (
          <>
            <Button variant="danger" disabled={busy} onClick={() => respond("decline")}>Rechazar</Button>
            <Button disabled={busy} onClick={() => respond("acceptForSession")}>Aprobar para la sesión</Button>
            <Button variant="primary" disabled={busy} className="md:ml-auto" onClick={() => respond("accept")}>Aprobar</Button>
          </>
        )}
        {!answerable && !detail?.inputAnswerable && !detail?.canMessage && reason && (
          <LinkButton variant="primary" href={item.appUrl}>
            Abrir en T3 <ExternalLink className="size-4" aria-hidden />
          </LinkButton>
        )}
        {running ? (
          <Button variant="danger" disabled={busy} onClick={() => void act("No se pudo detener", () => api("POST /api/threads/:machine/:thread/stop", { params }))}>Detener</Button>
        ) : (
          <Button disabled={busy} onClick={() => void act("No se pudo marcar como resuelto", async () => { await api("POST /api/threads/:machine/:thread/settle", { params }); onClose(); })}>Marcar como resuelto</Button>
        )}
        {(answerable || detail?.inputAnswerable || detail?.canMessage || !reason) && (
          <LinkButton href={item.appUrl}>Abrir en T3 <ExternalLink className="size-4" aria-hidden /></LinkButton>
        )}
        {item.webUrl && <LinkButton variant="ghost" href={item.webUrl} target="_blank" rel="noreferrer">Web</LinkButton>}
      </div>
    </div>
  );

  return (
    <Overlay label={reason ? `${TITLE[reason]}: ${item.title}` : item.title} header={header} footer={footer} onClose={onClose}>
      <div className="grid gap-3">
        <div className="flex items-center gap-2 text-[12.5px] text-muted-fg">
          <ProjectTag projectKey={projectKey} name={titles.get(projectKey) ?? machine} className="shrink-0 font-medium text-tx2" />
          <span className="min-w-0 flex-1 truncate">· {machine} · {ago(item.updatedAt)}</span>
          {reason ? <Chip tone="need">{CHIP[reason]}</Chip> : <StatusChip status={item.status} />}
        </div>
        <h3 className="text-[17px] font-semibold break-words">{item.title}</h3>

        {pending && (
          <p className="flex items-start gap-2 rounded-ctl bg-need-bg px-3 py-2 text-[13px] break-words text-[#7c3d06]">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{requestKindLabel(pending.kind)}{pending.summary ? ` · ${pending.summary}` : ""}</span>
          </p>
        )}
        {item.waitingUntil && <p className="text-[13px] text-need">Esperando el límite de uso hasta {at(item.waitingUntil)}</p>}

        {detail?.messages?.length ? <ChatHistory messages={detail.messages} /> : steps ? (
          <ol className="divide-y divide-soft overflow-hidden rounded-[10px] border border-line">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3 px-3 py-2.5 text-[13.5px]">
                <span aria-hidden className="mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-md bg-need text-xs font-bold text-white">{i + 1}</span>
                <span className="min-w-0 break-words">{s}</span>
              </li>
            ))}
          </ol>
        ) : (
          text && <p className="max-h-80 overflow-y-auto rounded-ctl bg-soft p-3 text-[13.5px] break-words whitespace-pre-wrap">{text}</p>
        )}

        {loadError && !detail && <ErrorNote>No se pudo cargar el detalle. {loadError}</ErrorNote>}
        {pending && detail?.inputAnswerable && pending.questions && <ThreadInput key={pending.id} questions={pending.questions} busy={busy} onSubmit={(answers) => void act("No se pudo enviar la respuesta", async () => { await api("POST /api/threads/:machine/:thread/answer", { params, body: { requestId: pending.id, answers } }); onClose(); })} />}
        {detail?.canMessage && <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (listening || busy) return; void act("No se pudo enviar el mensaje", async () => { await api("POST /api/threads/:machine/:thread/message", { params, body: { text: message, commandId: messageCommand.current } }); onClose(); }); }}>
          <label className="font-semibold" htmlFor="thread-reply">Responder desde el CC</label>
          <DictationTextarea id="thread-reply" placeholder="Escribí tu respuesta o la siguiente instrucción" value={message} maxLength={20000} disabled={busy} onListeningChange={setListening} onValueChange={(value) => { setMessage(value); messageCommand.current = crypto.randomUUID(); }} />
          <p className="text-xs text-muted-fg">Se envía a este mismo hilo en {machine}.</p>
          <Button type="submit" variant="primary" disabled={busy || listening || !message.trim()}>Enviar mensaje</Button>
        </form>}
        {pending && detail && !detail.answerable && !detail.inputAnswerable && <p className="text-[13px] text-muted-fg">Esta solicitud requiere la interfaz de T3, por ejemplo para iniciar sesión o adjuntar archivos.</p>}
      </div>
    </Overlay>
  );
}
