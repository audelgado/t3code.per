import { CANCEL_TASK_CONFIRMATION } from "./chatConfirm.ts";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RuntimeMode } from "../../server/types.ts";
import { ago, at, priorityLabel, PRIORITIES, projectColor, RUNTIME_MODES, runtimeModeLabel, STAGES, TONES } from "./look.ts";
import { hashes } from "./navigation.ts";
import { StatusChip, Chip } from "./ui/Chip.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Select } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { BUCKET_LABEL, BUCKET_TONE, entryAction, entryTone, entryWhy, type WorkEntry } from "./workDirectory.ts";
import { taskCall, useAct } from "./workData.ts";
import { ErrorNote, ProjectTag } from "./workUi.tsx";

const CANCELLABLE = new Set(["pending_approval", "queued", "starting", "running", "waiting", "needs_you"]);

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-fg">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** The task's journey through the seven git stages. The current one carries what it waits for. */
function Timeline({ entry }: { entry: WorkEntry }) {
  const stage = entry.row?.stage ?? 0;
  const tone = TONES[entryTone(entry)].fg;
  const project = projectColor(entry.projectKey);
  const why = entryWhy(entry);
  return (
    <ol aria-label="Etapas">
      {STAGES.map((name, i) => {
        const done = i < stage;
        const cur = i === stage;
        const paint = done ? project : tone;
        return (
          <li key={name} className="flex gap-3">
            <span className="flex flex-col items-center" aria-hidden>
              <span
                className="mt-1 block size-3 rounded-full border-2 border-line bg-panel"
                style={done ? { background: paint, borderColor: paint } : cur ? { borderColor: paint } : undefined}
              />
              {i < STAGES.length - 1 && <span className="block min-h-4 w-0.5 flex-1 bg-line" style={done ? { background: paint } : undefined} />}
            </span>
            <span className={`pb-1.5 ${cur ? "font-semibold" : done ? "" : "text-muted-fg"}`}>
              {name}
              {cur && why && <> · <span style={{ color: tone }}>{why}</span></>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Keeps the aside as tall as the viewport leaves it: below its container's top edge, then below the 1rem the sticky offset leaves. Writes the style directly so scrolling never re-renders. */
function useFitViewport(ref: { current: HTMLElement | null }) {
  useEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const fit = () => {
      const px = `${Math.max(240, innerHeight - Math.max(16, box.getBoundingClientRect().top) - 16)}px`;
      if (el.style.maxHeight !== px) el.style.maxHeight = px;
    };
    fit();
    addEventListener("scroll", fit, { passive: true });
    addEventListener("resize", fit);
    return () => {
      removeEventListener("scroll", fit);
      removeEventListener("resize", fit);
    };
  }, [ref]);
}

/** Detail of one entry: the aside of the Lista on desktop, a bottom sheet on the phone and over the Tablero. Key it by entry. */
export function WorkDetail({ entry, variant, onClose }: { entry: WorkEntry; variant: "aside" | "sheet"; onClose: () => void }) {
  const t = entry.task;
  const r = entry.row;
  const { busy, error, act } = useAct();
  const aside = useRef<HTMLElement>(null);
  useFitViewport(aside);
  const [mode, setMode] = useState<RuntimeMode>("auto-accept-edits");
  const action = entryAction(entry);
  const why = entryWhy(entry);
  const appUrl = r?.appUrl ?? entry.thread?.appUrl;
  const webUrl = r?.webUrl ?? entry.thread?.webUrl;
  const changes = [r?.ahead ? `${r.ahead} adelante` : null, r?.behind ? `${r.behind} atrás` : null, r?.changedFiles ? `${r.changedFiles} sin commitear` : null].filter(Boolean);

  const body = (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {t ? <StatusChip status={t.status} /> : <Chip tone={BUCKET_TONE[entry.bucket]}>{BUCKET_LABEL[entry.bucket]}</Chip>}
        <span className="text-[12.5px] text-muted-fg">
          {entry.machineLabel}
          {t && t.source !== "user" && ` · de ${t.source.slice(6)}`} · {ago(entry.updatedAt)}
        </span>
      </div>

      {r ? (
        <Timeline entry={entry} />
      ) : why ? (
        <p className="rounded-ctl bg-queue-bg px-3 py-2 text-[13px] text-tx2">{why}</p>
      ) : null}

      {t?.status === "waiting" && t.limitResetAt && <p className="text-[13px] text-need">Esperando el límite de uso hasta {at(t.limitResetAt)}</p>}
      {t && t.blockedBy.length > 0 && <p className="text-[13px] text-muted-fg">Bloqueada por {entry.blockedBy.join(", ")}</p>}
      {t?.error && <p className="text-[13px] break-words text-fail">{t.error}</p>}

      {t?.result && (
        <section className="grid gap-1">
          <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">Resultado</h3>
          <p className="max-h-60 overflow-y-auto rounded-ctl bg-soft p-2.5 text-[13px] break-words whitespace-pre-wrap">{t.result}</p>
        </section>
      )}
      {t &&
        // An agent-submitted prompt is shown in full: approving it launches an agent with this text.
        (t.status === "pending_approval" ? (
          <section className="grid gap-1">
            <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">Prompt</h3>
            <p className="max-h-72 overflow-y-auto rounded-ctl bg-soft p-2.5 text-[13px] break-words whitespace-pre-wrap">{t.prompt}</p>
          </section>
        ) : (
          <details className="text-[13px]">
            <summary className="cursor-pointer text-muted-fg">Prompt</summary>
            <p className="mt-1 max-h-60 overflow-y-auto rounded-ctl bg-soft p-2.5 break-words whitespace-pre-wrap">{t.prompt}</p>
          </details>
        ))}

      <dl className="grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        <Fact label="Proyecto"><ProjectTag projectKey={entry.projectKey} name={entry.projectTitle} className="text-[12.5px] text-fg" /></Fact>
        {r && <Fact label="Checkout"><span className="font-mono text-xs">{r.worktreePath ?? r.branch}</span></Fact>}
        {t && <Fact label="Prioridad">{priorityLabel(t.priority)}</Fact>}
        {t && <Fact label="Permisos">{runtimeModeLabel(t.runtimeMode)}</Fact>}
        {t?.model && <Fact label="Modelo">{t.model.model}</Fact>}
        {changes.length > 0 && <Fact label="Cambios">{changes.join(" · ")}</Fact>}
        {r && r.threadCount > 1 && <Fact label="Hilos">{r.threadCount}</Fact>}
        {r?.pr && (
          <Fact label="PR">
            <a className="text-primary" href={r.pr.url} target="_blank" rel="noreferrer">#{r.pr.number}{r.pr.state ? ` · ${r.pr.state === "open" ? (r.pr.isDraft ? "borrador" : "abierto") : r.pr.state === "merged" ? "mergeado" : "cerrado"}` : ""}</a>
          </Fact>
        )}
        {t && <Fact label="Creada">{at(t.createdAt)}</Fact>}
      </dl>
    </div>
  );

  const footer = (
    <div className="grid gap-2">
      {error && <ErrorNote>{error}</ErrorNote>}
      {t?.status === "pending_approval" && (
        <label className="grid gap-1">
          <span className="text-xs font-medium text-muted-fg">Permisos al aprobar</span>
          <Select name="approval-runtime-mode" value={mode} onChange={(e) => setMode(e.target.value as RuntimeMode)}>
            {RUNTIME_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </label>
      )}
      {t?.status === "queued" && (
        <label className="grid gap-1">
          <span className="text-xs font-medium text-muted-fg">Prioridad</span>
          <Select name="task-priority" value={Math.max(-2, Math.min(2, Math.round(t.priority)))} disabled={busy} onChange={(e) => void act("No se pudo cambiar la prioridad", () => taskCall.priority(t.id, Number(e.target.value)))}>
            {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {t?.status === "pending_approval" && (
          <>
            <Button variant="danger" disabled={busy} onClick={() => void act("No se pudo rechazar", () => taskCall.reject(t.id))}>Rechazar</Button>
            <Button variant="primary" disabled={busy} className="md:ml-auto" onClick={() => void act("No se pudo aprobar", () => taskCall.approve(t.id, mode))}>Aprobar</Button>
          </>
        )}
        {action?.kind === "thread" && entry.thread && <LinkButton variant="primary" href={hashes.thread(entry.thread.key)}>{action.label}</LinkButton>}
        {t && (t.status === "failed" || t.status === "cancelled") && (
          <Button disabled={busy} onClick={() => void act("No se pudo reintentar", () => taskCall.retry(t.id))}>Reintentar</Button>
        )}
        {t && CANCELLABLE.has(t.status) && t.status !== "pending_approval" && (
          <Button variant="danger" disabled={busy} onClick={() => { if (confirm(CANCEL_TASK_CONFIRMATION)) void act("No se pudo cancelar", () => taskCall.cancel(t.id)); }}>Cancelar</Button>
        )}
        {r?.pr && <LinkButton href={r.pr.url} target="_blank" rel="noreferrer">Ver PR</LinkButton>}
        {appUrl && <LinkButton href={appUrl}>Abrir en T3</LinkButton>}
        {webUrl && <LinkButton variant="ghost" href={webUrl} target="_blank" rel="noreferrer">Web</LinkButton>}
      </div>
    </div>
  );

  if (variant === "sheet") {
    return (
      <Sheet title={entry.title} onClose={onClose} footer={footer}>
        {body}
      </Sheet>
    );
  }
  return (
    <aside ref={aside} aria-label="Detalle" className="sticky top-4 flex w-[350px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <ProjectTag projectKey={entry.projectKey} name={entry.projectTitle} className="font-semibold text-fg" />
        {r && <span className="min-w-0 truncate font-mono text-xs text-muted-fg" title={r.worktreePath ?? r.branch}>{r.branch}</span>}
        <Button variant="ghost" size="icon" aria-label="Cerrar detalle" className="ml-auto" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="mb-3 text-base font-semibold break-words">{entry.title}</h2>
        {body}
      </div>
      <div className="border-t border-line px-4 py-3">{footer}</div>
    </aside>
  );
}
