// "Ordenar con IA" pieces of Pedir: coordinator pills, the job hook and the static progress/review banners.
import { Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Coordinator, CoordinatorId, OrganizeDraft } from "../../server/organize.ts";
import { call } from "./api.ts";
import { COORDINATOR_STORAGE_KEY, pickCoordinator, pollJob } from "./organizeFlow.ts";
import { Button } from "./ui/Button.tsx";
import { cn } from "./ui/cn.ts";

interface SegmentItem<T extends string | number> {
  id: T;
  label: string;
  disabled?: boolean;
  /** Tooltip; for a disabled item, the reason. */
  title?: string;
}

/** Pills in one row where exactly one is selected (priority, coordinator). */
export function Segmented<T extends string | number>({ items, value, onChange, label, className }: { items: readonly SegmentItem<T>[]; value: T | null; onChange: (id: T) => void; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex gap-0.5 rounded-[10px] border border-line bg-panel p-[3px]", className)}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="radio"
          aria-checked={it.id === value}
          disabled={it.disabled}
          title={it.title}
          onClick={() => onChange(it.id)}
          className={cn(
            "h-9 min-w-0 flex-1 truncate rounded-[7px] px-2 text-sm md:h-[30px]",
            it.id === value ? "bg-fg font-semibold text-panel" : "text-muted-fg active:bg-soft",
            it.disabled && "cursor-not-allowed opacity-45",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

const read = () => {
  try {
    return localStorage.getItem(COORDINATOR_STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * Coordinator list, the remembered choice and one organize job at a time. The job is polled until it
 * settles; `cancel` and unmounting (closing Pedir) stop the polling, nothing is cancelled server side.
 * `onDraft` runs with the latest closure, so it may read current state.
 */
export function useOrganize(onDraft: (draft: OrganizeDraft, coordinator: Coordinator) => void, targetProjectKey: string) {
  const [list, setList] = useState<Coordinator[] | null>(null);
  const [listError, setListError] = useState(false);
  const [picked, setPicked] = useState<CoordinatorId | null>(null);
  const [running, setRunning] = useState<Coordinator | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const emit = useRef(onDraft);
  emit.current = onDraft;

  useEffect(() => {
    let active = true;
    setList(null);
    setListError(false);
    setError(null);
    if (targetProjectKey) call("GET /api/organize/coordinators", { query: { targetProjectKey } }).then((list) => { if (active) setList(list); }, () => { if (active) setListError(true); });
    return () => { active = false; abort.current?.abort(); };
  }, [targetProjectKey]);

  const choice = list ? (list.find((c) => c.id === picked && c.available)?.id ?? pickCoordinator(list, read())) : null;
  const coordinator = list?.find((c) => c.id === choice) ?? null;

  const choose = (id: CoordinatorId) => {
    setPicked(id);
    try {
      localStorage.setItem(COORDINATOR_STORAGE_KEY, id);
    } catch {
      // Private mode: the choice just is not remembered.
    }
  };

  const start = async (text: string, projectKey: string) => {
    if (!coordinator) return;
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setError(null);
    setRunning(coordinator);
    try {
      const first = await call("POST /api/organize", { body: { text, coordinator: coordinator.id, projectKey: projectKey || null, targetProjectKey } });
      const job = await pollJob(first, (id) => call("GET /api/organize/:id", { params: { id } }), { signal: ctl.signal });
      if (job.status === "done" && job.draft) emit.current(job.draft, coordinator);
      else setError(job.error ?? "No se pudo ordenar el pedido. Probá de nuevo o encolá tu texto original.");
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : "No se pudo ordenar el pedido.");
    } finally {
      if (!ctl.signal.aborted) setRunning(null);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    setRunning(null);
  };

  return { list, listError, choice, coordinator, running, error, setError, choose, start, cancel };
}

/** Pills Claude · Codex · Hermes. Unavailable ones are disabled and say why on hover. */
export function CoordinatorPicker({ o, className }: { o: ReturnType<typeof useOrganize>; className?: string }) {
  if (o.listError) return <p className="text-xs text-muted-fg">No se pudieron cargar los coordinadores.</p>;
  if (!o.list) return null;
  return (
    <Segmented
      label="Coordinador"
      className={className}
      value={o.choice}
      onChange={o.choose}
      items={o.list.map((c) => ({ id: c.id, label: c.label, disabled: !c.available || o.running !== null, title: c.reason ?? undefined }))}
    />
  );
}

/** Static progress while a job runs: no spinner, the text says it all. */
export function OrderingBanner({ label, onCancel }: { label: string; onCancel: () => void }) {
  return (
    <div role="status" className="flex items-center gap-2 rounded-[10px] border border-run-bg bg-run-bg/50 px-3 py-2 text-sm text-run">
      <Sparkles className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 font-medium">Ordenando con {label}…</span>
      <button type="button" onClick={onCancel} className="text-muted-fg underline underline-offset-2">
        Cancelar
      </button>
    </div>
  );
}

/** Header of the review: who drafted it, the open questions, and the ways out. */
export function ReviewBanner({ label, questions, onDiscard, onRedo, busy }: { label: string; questions: string[]; onDiscard: () => void; onRedo: () => void; busy: boolean }) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-soft px-3 py-2 text-sm">
        <Sparkles className="size-4 shrink-0 text-run" aria-hidden />
        <span className="min-w-0 flex-1 basis-[calc(100%-1.5rem)] font-medium md:basis-0">Borrador de {label}. Revisalo antes de encolar.</span>
        <Button size="sm" onClick={onRedo} disabled={busy}>
          Volver a ordenar
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          <X className="size-4" aria-hidden /> Usar mi texto original
        </Button>
      </div>
      {questions.length > 0 && (
        <div role="note" className="rounded-[10px] bg-need-bg px-3 py-2 text-sm text-need">
          <p className="font-semibold">Preguntas abiertas. Respondelas editando el prompt.</p>
          <ul className="mt-1 list-disc pl-5">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
