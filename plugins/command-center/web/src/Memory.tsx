import { useCollectionDraft, useCollectionState } from "./collectionHooks.ts";
import { paginateCollection } from "./pagination.ts";
import { Pager } from "./ui/Pager.tsx";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MemoryEntry, MemoryKind } from "../../server/memory.ts";
import { call } from "./api.ts";
import { MEMORY_KIND_LABELS, memoryKindLabel, type Tone } from "./look.ts";
import { useProjectIndex } from "./projectIndex.ts";
import { splitProjectKey } from "./projectDirectory.ts";
import { Button } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Card, EmptyState, Input, Select, Textarea } from "./ui/fields.tsx";
import { Panel } from "./ui/Panel.tsx";
import { ProjectDot } from "./ui/ProjectDot.tsx";
import { Tabs } from "./ui/Tabs.tsx";

const kinds = Object.keys(MEMORY_KIND_LABELS) as MemoryKind[];
const kindTone: Record<MemoryKind, Tone> = { progress: "run", decision: "pr", todo: "need", handoff: "teal", note: "queue" };
const PAGE = 25;

const message = (e: unknown) => (e instanceof Error ? e.message : "No se pudo completar la acción");
const dayFormat = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "numeric", month: "short" });
const dayKey = (d: Date) => d.toDateString();
function dayLabel(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return "Hoy";
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return "Ayer";
  return dayFormat.format(d);
}

/** Entries grouped by local day, keeping the (already newest-first) order. */
function byDay(entries: MemoryEntry[]) {
  const days: { day: string; entries: MemoryEntry[] }[] = [];
  for (const e of entries) {
    const day = dayLabel(e.createdAt);
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(e);
    else days.push({ day, entries: [e] });
  }
  return days;
}

/**
 * Notes, todos, decisions and handoffs written by you and your agents. Standalone under Proyectos / Memoria,
 * or pass `projectKey` ("<machineId>:<projectId>") to embed it filtered by one project (project detail tab).
 */
export function Memory({ projectKey }: { projectKey?: string }) {
  const index = useProjectIndex();
  const fixed = projectKey ? splitProjectKey(projectKey).projectId : null;
  const [picked, setPicked] = useCollectionState("memory.picked", "all"); // "all" | "none" | project id
  const project = fixed ?? picked;
  const [kind, setKind] = useCollectionState<MemoryKind | "all">("memory.kind", "all", (v) => v === "all" || kinds.includes(v));
  const [search, setSearch] = useCollectionState("memory.search", "");
  const [query, setQuery] = useState(search.trim());
  const [pageNumber, setPageNumber] = useCollectionState("memory.page", 1);
  const [loading, setLoading] = useState(false);
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [todos, setTodos] = useState<MemoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useCollectionDraft<{ kind: MemoryKind; text: string } | null>(`memory.${projectKey ?? project}`, null);
  const cancelDraft = () => {
    if (!busy && (!draft || confirm("¿Descartar el borrador sin guardar?"))) setDraft(null);
  };
  const seq = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const scope = { projectId: project === "all" ? undefined : project === "none" ? null : project };
  const load = async (after?: MemoryEntry) => {
    const n = ++seq.current; // a slower, older response must not overwrite a newer filter
    setLoading(true);
    try {
      let [page, open] = await Promise.all([
        call("POST /api/memory/list", {
          body: { ...scope, kind: kind === "all" ? undefined : kind, query: query || undefined, limit: PAGE, before: after?.id, beforeCreatedAt: after?.createdAt },
        }),
        after ? null : call("POST /api/memory/list", { body: { ...scope, kind: "todo", done: false, query: query || undefined, limit: 50 } }),
      ]);
      if (n !== seq.current) return;
      const loaded = [...page.entries];
      while (!after && page.hasMore && loaded.length < pageNumber * PAGE) {
        const last = loaded.at(-1);
        if (!last) break;
        page = await call("POST /api/memory/list", { body: { ...scope, kind: kind === "all" ? undefined : kind, query: query || undefined, limit: PAGE, before: last.id, beforeCreatedAt: last.createdAt } });
        if (n !== seq.current) return;
        if (!page.entries.length) break;
        loaded.push(...page.entries);
      }
      setEntries((prev) => (after && prev ? [...prev, ...loaded] : loaded));
      if (after) setPageNumber((p) => p + 1);
      setMore(page.hasMore);
      if (open) setTodos(open.entries);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(message(e));
    } finally { if (n === seq.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { seq.current++; }; }, [project, kind, query]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (e: MemoryEntry) => act(() => call("POST /api/memory/:id/done", { params: { id: e.id }, body: { done: !e.done } }));
  const remove = (e: MemoryEntry) => confirm("¿Eliminar esta entrada?") && act(() => call("DELETE /api/memory/:id", { params: { id: e.id } }));
  const save = () =>
    draft &&
    act(async () => {
      await call("POST /api/memory", { body: { kind: draft.kind, text: draft.text, projectId: scope.projectId ?? null } });
      setDraft(null);
    });

  // Open todos are actionable, so they get their own panel (never paged); the timeline shows the rest.
  const showTodos = todos.length > 0 && (kind === "all" || kind === "todo");
  const pagination = paginateCollection(entries ?? [], pageNumber, PAGE);
  const timeline = showTodos ? pagination.items.filter((e) => e.kind !== "todo" || e.done || !todos.some((todo) => todo.id === e.id)) : pagination.items;
  const row = (e: MemoryEntry, compact = false) => {
    const pk = e.projectId ? index.key(e.projectId) : null;
    return (
      <div key={e.id} className="flex items-start gap-3 px-4 py-3">
        {e.kind === "todo" ? (
          <input id={`memory-todo-${e.id}`} type="checkbox" className="mt-0.5 size-5 shrink-0 accent-primary" checked={e.done} disabled={busy} onChange={() => void toggle(e)} aria-label={`Hecho: ${e.text.slice(0, 40)}`} />
        ) : (
          <span aria-hidden className="mt-1.5 size-3 shrink-0 rounded-[3px] md:hidden" style={{ background: `var(--${kindTone[e.kind]})` }} />
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={e.kind === "todo" ? `memory-todo-${e.id}` : undefined} className={cn("break-words whitespace-pre-wrap", e.kind === "todo" && "cursor-pointer", e.kind === "todo" && e.done && "text-muted-fg line-through")}>{e.text}</label>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-fg">
            <Chip tone={kindTone[e.kind]} className="hidden md:inline-flex">{memoryKindLabel(e.kind)}</Chip>
            <span className="md:hidden">{memoryKindLabel(e.kind)}</span>
            {!compact && (
              <span className="flex min-w-0 items-center gap-1.5">
                {pk && <ProjectDot projectKey={pk} />}
                <span className="truncate">{e.projectId ? index.title(e.projectId) : "Sin proyecto"}</span>
              </span>
            )}
            {e.source !== "user" && <span>{e.source === "agent" ? "agente" : "sistema"}</span>}
            <span>{ago(e.createdAt)}</span>
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Eliminar entrada" disabled={busy} onClick={() => void remove(e)}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    );
  };

  const filtered = !!query || kind !== "all" || (!fixed && project !== "all");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          label="Tipo de entrada"
          value={kind}
          onChange={(v) => { setKind(v); setPageNumber(1, true); }}
          items={[{ id: "all" as const, label: "Todas" }, ...kinds.map((k) => ({ id: k, label: memoryKindLabel(k) }))]}
        />
        <span className="flex-1" />
        <Button disabled={busy} onClick={() => draft ? cancelDraft() : setDraft({ kind: "note", text: "" })} aria-expanded={draft !== null}>
          <Plus className="size-4" aria-hidden /> Agregar
        </Button>
      </div>

      {draft && (
        <Card aria-busy={busy} className="grid gap-2">
          <Select disabled={busy} value={draft.kind} aria-label="Tipo" onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {memoryKindLabel(k)}
              </option>
            ))}
          </Select>
          <Textarea disabled={busy} aria-label="Contenido de la memoria" value={draft.text} maxLength={20000} autoFocus placeholder="¿Qué hay que recordar?" onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={cancelDraft}>Cancelar</Button>
            <Button variant="primary" disabled={busy || !draft.text.trim()} onClick={() => void save()}>
              {busy ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Input className="min-w-[14rem] flex-1 md:min-w-0 md:max-w-sm" type="search" value={search} placeholder="Buscar en la memoria…" aria-label="Buscar en la memoria" onChange={(e) => { setSearch(e.target.value); setPageNumber(1, true); }} />
        {!fixed && (
          <Select className="w-auto max-w-full" value={picked} aria-label="Proyecto" onChange={(e) => { setPicked(e.target.value); setPageNumber(1, true); }}>
            <option value="all">Todos los proyectos</option>
            <option value="none">Sin proyecto</option>
            {index.list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && <p role="alert" className="text-fail">{error}</p>}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {showTodos && (
          <Panel title="Pendientes abiertos" count={todos.length} className="lg:col-start-2 lg:row-start-1">
            {todos.map((e) => row(e, !!fixed))}
          </Panel>
        )}
        <div className="grid gap-3 lg:col-start-1 lg:row-start-1">
          {entries === null ? (
            error ? null : <p className="text-muted-fg">Cargando…</p>
          ) : entries.length === 0 && !more ? (
            showTodos ? null : <EmptyState>{filtered ? "Sin elementos" : "Todavía no hay memoria. Agrega una nota o deja que un agente llame a memory_save."}</EmptyState>
          ) : (
            <Panel>
              {byDay(timeline).map(({ day, entries: list }) => (
                <div key={day}>
                  <h3 className="bg-soft/60 px-4 py-1.5 text-xs font-semibold tracking-wide text-muted-fg uppercase">{day}</h3>
                  <div className="divide-y divide-soft">{list.map((e) => row(e, !!fixed))}</div>
                </div>
              ))}
              <div className="px-4 py-2"><Pager page={pagination} onPageChange={setPageNumber} label="Memoria" /></div>
              {more && entries && pagination.page === pagination.pageCount && (
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-xs text-muted-fg">Más recientes primero</span>
                  <Button disabled={busy || loading} onClick={() => void load(entries.at(-1))}>
                    Anteriores
                  </Button>
                </div>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
