import { useCollectionState } from "./collectionHooks.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryEntry, MemoryPage } from "../../server/memory.ts";
import type { Artifact } from "../../server/artifacts.ts";
import { call } from "./api.ts";
import { hashes } from "./navigation.ts";
import { splitProjectKey } from "./projectDirectory.ts";
import { planMilestones, planTodos } from "./projectPlan.ts";
import { SectionLine, type SectionsStore } from "./Sections.tsx";
import { ProjectAuditPanel } from "./ProjectAudit.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Input, Select, Textarea } from "./ui/fields.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Pager } from "./ui/Pager.tsx";
import { paginateCollection } from "./pagination.ts";
import { ago, cn } from "./ui/cn.ts";

const message = (e: unknown) => e instanceof Error ? e.message : "No se pudo guardar el seguimiento";

/** Durable project plan, using the same memory and sections exposed to agents. No task is launched here. */
export function ProjectPlan({ projectKey, store, compact = false, onChanged }: { projectKey: string; store: SectionsStore; compact?: boolean; onChanged?: () => void }) {
  const { projectId } = splitProjectKey(projectKey);
  const [todos, setTodos] = useState<MemoryPage | null>(null);
  const [progress, setProgress] = useState<MemoryEntry | null>(null);
  const [docs, setDocs] = useState<Artifact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftSection, setDraftSection] = useState("");
  const [update, setUpdate] = useState<string | null>(null);
  const [filter, setFilter] = useCollectionState("plan.filter", "open", (v) => ["open", "done", "all"].includes(v));
  const [query, setQuery] = useCollectionState("plan.query", "");
  const [section, setSection] = useCollectionState("plan.section", "");
  const [page, setPage] = useCollectionState("plan.page", 1);
  const [expanded, setExpanded] = useState(false);
  const seq = useRef(0);
  const done = compact || filter === "open" ? false : filter === "done" ? true : undefined;
  const target = useRef({ page, filter, query, section });
  target.current = { page, filter, query, section };
  const load = useCallback(async () => {
    const requested = target.current;
    const n = ++seq.current;
    try {
      const [checklist, state, documents] = await Promise.all([
        call("POST /api/memory/list", { body: { projectId, kind: "todo", done, limit: 100 } }),
        call("POST /api/memory/list", { body: { projectId, kind: "progress", limit: 1 } }),
        call("POST /api/artifacts/list", { body: { projectId, archived: false, query: "PRD", limit: 10 } }),
      ]);
      if (n !== seq.current) return;
      const entries = [...checklist.entries];
      let hasMore = checklist.hasMore;
      while (!compact && hasMore && planTodos(entries, projectId, requested.filter, requested.query, requested.section).length < requested.page * 10) {
        const last = entries.at(-1);
        if (!last) break;
        const next = await call("POST /api/memory/list", { body: { projectId, kind: "todo", done, limit: 100, before: last.id, beforeCreatedAt: last.createdAt } });
        if (n !== seq.current) return;
        hasMore = next.hasMore;
        if (!next.entries.length) break;
        entries.push(...next.entries);
      }
      setTodos({ entries, hasMore }); setProgress(state.entries[0] ?? null); setDocs(documents.artifacts); setError(null);
    } catch (e) { if (n === seq.current) setError(message(e)); }
  }, [projectId, done, compact]);
  useEffect(() => {
    setTodos(null); setProgress(null); setDocs([]); setDraft(""); setUpdate(null); setDraftSection("");
  }, [projectId]);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const milestones = planMilestones(store.sections ?? [], projectId);
  const matches = planTodos(todos?.entries ?? [], projectId, compact ? "open" : filter, compact ? "" : query, compact ? "" : section);
  const pagination = paginateCollection(matches, page, compact ? 5 : 10);

  return <div className="grid min-w-0 gap-4">
    {!compact && <ProjectAuditPanel projectKey={projectKey} onApplied={() => { void load(); store.reload(); onChanged?.(); }} />}
    {error && <p role="alert" className="text-fail">{error} <Button onClick={() => void load()}>Reintentar</Button></p>}
    <Panel title="Dónde estamos" action={compact ? <LinkButton size="sm" href={hashes.project(projectKey, "plan")}>Ver plan y pendientes</LinkButton> : <Button size="sm" disabled={busy} onClick={() => setUpdate(progress?.text ?? "")}>Actualizar avance</Button>}>
      <div className="grid gap-2 px-4 py-3">
        {progress ? <><p className={cn("break-words whitespace-pre-wrap", (compact || !expanded) && "line-clamp-4")}>{progress.text}</p>{!compact && <Button size="sm" className="justify-self-start" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Ver menos" : "Ver avance completo"}</Button>}<p className="text-xs text-muted-fg">Último registro {ago(progress.updatedAt)} · {progress.source === "user" ? "tú" : "agente"}</p></>
          : <p className="text-muted-fg">Registra el objetivo, el alcance entregado y el próximo paso. Un chat terminado no cierra el proyecto.</p>}
        <p className="text-xs text-muted-fg">{todos ? `${todos.entries.length}${todos.hasMore ? "+" : ""} registros en esta vista` : "Cargando pendientes…"} · {store.sections ? `${milestones.done} de ${milestones.sections.length} fases cerradas` : "Cargando fases…"}</p>
        {!compact && <p className="text-xs text-muted-fg">El avance es el último registro guardado. Usa Revisar y organizar para actualizarlo desde la evidencia del proyecto.</p>}
      </div>
      {update !== null && <form className="grid gap-2 px-4 py-3" onSubmit={(e) => { e.preventDefault(); void act(async () => { await call("POST /api/memory", { body: { projectId, kind: "progress", text: update } }); setUpdate(null); }); }}>
        <Textarea aria-label="Avance del proyecto" value={update} maxLength={20000} onChange={(e) => setUpdate(e.target.value)} placeholder="Objetivo, qué está validado, qué falta y próximo paso…" />
        <div className="flex gap-2"><Button type="submit" variant="primary" disabled={busy || !update.trim()}>Guardar avance</Button><Button onClick={() => setUpdate(null)}>Cancelar</Button></div>
      </form>}
    </Panel>
    {!compact && <div className="grid items-start gap-4 lg:grid-cols-2">
      <Panel title="PRD y alcance" action={<LinkButton size="sm" href={hashes.project(projectKey, "artifacts")}>Documentos</LinkButton>}>
        <div className="grid gap-2 px-4 py-3">{docs.length ? docs.map((d) => <a className="font-semibold text-primary" key={d.id} href={hashes.project(projectKey, "artifacts")}>{d.title} · v{d.currentVersion}</a>) : <p className="text-muted-fg">Guarda un documento con «PRD» en el título en Artefactos: objetivo, alcance y criterios de aceptación.</p>}</div>
      </Panel>
      <Panel title="Bloqueos" count={store.sections ? milestones.blocked.length : undefined} action={<LinkButton size="sm" href={hashes.project(projectKey, "sections")}>Editar fases</LinkButton>}>
        <div className="grid gap-2 px-4 py-3">{store.error ? <p role="alert" className="text-fail">{store.error}</p> : !store.sections ? <p>Cargando…</p> : milestones.blocked.length ? milestones.blocked.map((s) => <p key={s.id} className="break-words"><strong>{s.name}:</strong> {s.blocker || "Pendiente de desbloquear"}</p>) : <p className="text-muted-fg">Sin bloqueos registrados.</p>}</div>
      </Panel>
    </div>}
    <Panel title="Pendientes" count={todos && !todos.hasMore ? matches.length : undefined} action={!compact ? <Button size="sm" disabled={busy} onClick={() => void load()}>Actualizar</Button> : undefined}>
      {!compact && <div className="grid gap-3 px-4 py-3">
        <p className="text-xs text-muted-fg">Marcar hecho registra el resultado. No ejecuta agentes; puedes reabrirlo desmarcando.</p>
        <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { await call("POST /api/memory", { body: { projectId, kind: "todo", text: draft, sectionId: draftSection || null } }); setDraft(""); }); }}>
          <Input aria-label="Nuevo pendiente" placeholder="Resultado concreto que falta y cómo validarlo…" maxLength={20000} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="flex gap-2"><Select aria-label="Fase del nuevo pendiente" value={draftSection} onChange={(e) => setDraftSection(e.target.value)}><option value="">Sin fase</option>{milestones.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select><Button type="submit" variant="primary" disabled={busy || !draft.trim()}>Agregar</Button></div>
        </form>
        <div className="grid gap-2 sm:grid-cols-3">
          <Select aria-label="Estado de pendientes" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(1, true); }}><option value="open">Pendientes</option><option value="done">Hechos</option><option value="all">Todos</option></Select>
          <Select aria-label="Filtrar pendientes por fase" value={section} onChange={(e) => { setSection(e.target.value); setPage(1, true); }}><option value="">Todas las fases</option><option value="none">Sin fase</option>{milestones.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
          <Input type="search" aria-label="Buscar pendientes" placeholder="Buscar pendiente…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1, true); }} />
        </div>
      </div>}
      {!todos ? <p className="px-4 py-3 text-muted-fg">{error ? "No se pudo cargar el plan." : "Cargando…"}</p> : !matches.length ? <p className="px-4 py-3 text-muted-fg">{filter === "open" ? "Sin pendientes registrados en esta vista. Comprueba el PRD antes de dar el proyecto por terminado." : "No hay pendientes que coincidan."}</p> : pagination.items.map((todo) => <div key={todo.id} className="flex items-start gap-3 px-4 py-3">
        <input id={`plan-todo-${todo.id}`} className="mt-1 size-5 shrink-0 accent-primary" type="checkbox" checked={todo.done} disabled={busy} aria-label={`Hecho: ${todo.text}`} onChange={() => void act(() => call("POST /api/memory/:id/done", { params: { id: todo.id }, body: { done: !todo.done } }))} />
        <div className="grid min-w-0 gap-1"><label htmlFor={`plan-todo-${todo.id}`} className={cn("cursor-pointer break-words whitespace-pre-wrap", todo.done && "text-muted-fg line-through")}>{todo.text}</label>{todo.sectionId && <span className="text-xs text-muted-fg">{store.names.get(todo.sectionId) ?? "Fase archivada"}</span>}</div>
      </div>)}
      {compact && matches.length > 5 && <a className="block px-4 py-3 text-primary" href={hashes.project(projectKey, "plan")}>Ver todos los pendientes</a>}
    </Panel>
    {!compact && <>
      <Pager page={pagination} onPageChange={setPage} label="Pendientes" />
      {todos?.hasMore && <Button disabled={busy} onClick={() => { const last = todos.entries.at(-1); if (!last) return; const n = seq.current; setBusy(true); call("POST /api/memory/list", { body: { projectId, kind: "todo", done, limit: 100, before: last.id, beforeCreatedAt: last.createdAt } }).then((next) => { if (n === seq.current) setTodos((prev) => prev ? { entries: [...prev.entries, ...next.entries], hasMore: next.hasMore } : next); }, (e) => setError(message(e))).finally(() => setBusy(false)); }}>Cargar más pendientes</Button>}
      <Panel title="Fases del proyecto" action={<LinkButton size="sm" href={hashes.project(projectKey, "sections")}>Gestionar fases</LinkButton>}>
        {store.error ? <p role="alert" className="px-4 py-3 text-fail">{store.error}</p> : !store.sections ? <p className="px-4 py-3">Cargando…</p> : milestones.sections.length ? milestones.sections.slice(0, 5).map((s) => <div key={s.id} className="px-4 py-3"><SectionLine s={s} /></div>) : <p className="px-4 py-3 text-muted-fg">Crea fases en Secciones, por ejemplo: definición, implementación, validación y lanzamiento. Sus conteos se actualizan por separado de esta lista.</p>}
        {milestones.sections.length > 5 && <a className="block px-4 py-3 text-primary" href={hashes.project(projectKey, "sections")}>Ver las {milestones.sections.length} fases</a>}
      </Panel>
    </>}
  </div>;
}
