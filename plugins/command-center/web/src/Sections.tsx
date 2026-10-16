import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SECTION_STATUSES, selectSectionPage, type Section, type SectionFields, type SectionStatus } from "../../server/sections.ts";
import { call } from "./api.ts";
import { sectionStatusLabel, type Tone } from "./look.ts";
import { Button } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { Badge, EmptyState, Field, Input, Select, Textarea } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Panel } from "./ui/Panel.tsx";

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const tone: Record<SectionStatus, Tone> = { todo: "queue", in_progress: "run", review: "pr", blocked: "fail", done: "ok" };
const bar: Record<SectionStatus, string | undefined> = { todo: undefined, in_progress: undefined, review: undefined, blocked: "var(--fail)", done: "var(--ok)" };
const dueFormat = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
/** YYYY-MM-DD -> "24 oct". Parsed as local noon so the day never shifts with the time zone. */
const dueLabel = (iso: string) => dueFormat.format(new Date(`${iso}T12:00:00`));

/** One project's sections plus the edits, shared by the project detail's Resumen and Secciones tabs. */
export function useSections() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    call("GET /api/sections").then(setSections, (e) => setError(message(e, "No se pudo cargar las secciones")));
  }, []);
  const changed = useCallback((s: Section) => setSections((all) => (all?.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? s : x)) : [...(all ?? []), s])), []);
  const deleted = useCallback((id: string) => setSections((all) => (all ?? []).filter((x) => x.id !== id).map((x) => (x.dependsOn.includes(id) ? { ...x, dependsOn: x.dependsOn.filter((d) => d !== id) } : x))), []);
  const names = useMemo(() => new Map((sections ?? []).map((s) => [s.id, s.name])), [sections]);
  return { sections, error, changed, deleted, names };
}
export type SectionsStore = ReturnType<typeof useSections>;

/** Name, status, progress and the notes that matter; `extra` adds rows below (the Secciones tab uses it). */
export function SectionLine({ s, extra }: { s: Section; extra?: ReactNode }) {
  const pct = s.tasksTotal > 0 ? Math.min(100, Math.round((s.tasksDone / s.tasksTotal) * 100)) : 0;
  return (
    <div className="grid gap-1.5 md:grid-cols-[minmax(0,1fr)_200px] md:items-center md:gap-4">
      <div className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-semibold">{s.name}</span>
          <Chip tone={tone[s.status]}>{sectionStatusLabel(s.status)}</Chip>
        </span>
        {s.blocker ? (
          <span className="text-xs break-words text-fail">Bloqueo: {s.blocker}</span>
        ) : s.trying ? (
          <span className="text-xs break-words text-muted-fg">Probando: {s.trying}</span>
        ) : s.tasksDone === 0 && s.status === "todo" ? (
          <span className="text-xs text-muted-fg">Sin empezar</span>
        ) : null}
        {extra}
      </div>
      <div className="grid gap-1">
        <div role="progressbar" aria-valuemin={0} aria-valuemax={s.tasksTotal} aria-valuenow={s.tasksDone} aria-label="Tareas hechas" className="h-1.5 overflow-hidden rounded-full bg-[#e8e6e0]">
          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%`, background: bar[s.status] }} />
        </div>
        <span className="text-xs text-muted-fg tabular-nums">
          {s.tasksDone}/{s.tasksTotal} tareas{s.dueDate && ` · ${dueLabel(s.dueDate)}`}
        </span>
      </div>
    </div>
  );
}

function Editor({ section, onSaved, onDeleted, onClose }: { section: Section; onSaved: (s: Section) => void; onDeleted: (id: string) => void; onClose: () => void }) {
  const [f, setF] = useState({
    name: section.name,
    status: section.status,
    tasksDone: String(section.tasksDone),
    tasksTotal: String(section.tasksTotal),
    dueDate: section.dueDate ?? "",
    trying: section.trying ?? "",
    blocker: section.blocker ?? "",
    missing: section.missing.join("\n"),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    const body: Partial<SectionFields> = {
      name: f.name,
      status: f.status,
      tasksDone: Number(f.tasksDone),
      tasksTotal: Number(f.tasksTotal),
      dueDate: f.dueDate || null,
      trying: f.trying.trim() || null,
      blocker: f.blocker.trim() || null,
      missing: f.missing.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    try {
      onSaved(await call("PATCH /api/sections/:id", { params: { id: section.id }, body }));
      onClose();
    } catch (e) {
      setError(message(e, "No se pudo guardar"));
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`¿Eliminar "${section.name}"? Las secciones que dependen de ella dejan de esperar.`)) return;
    setBusy(true);
    setError(null);
    try {
      await call("DELETE /api/sections/:id", { params: { id: section.id } });
      onDeleted(section.id);
    } catch (e) {
      setError(message(e, "No se pudo eliminar"));
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 grid gap-2 border-t border-line pt-3">
      <Field label="Nombre">
        <Input value={f.name} maxLength={80} onChange={set("name")} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Estado">
          <Select value={f.status} onChange={set("status")}>
            {SECTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {sectionStatusLabel(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Vence">
          <Input type="date" value={f.dueDate} onChange={set("dueDate")} />
        </Field>
        <Field label="Tareas hechas">
          <Input inputMode="numeric" value={f.tasksDone} onChange={set("tasksDone")} />
        </Field>
        <Field label="Tareas en total">
          <Input inputMode="numeric" value={f.tasksTotal} onChange={set("tasksTotal")} />
        </Field>
      </div>
      <Field label="Probando">
        <Input value={f.trying} maxLength={500} onChange={set("trying")} />
      </Field>
      <Field label="Bloqueo">
        <Input value={f.blocker} maxLength={500} onChange={set("blocker")} />
      </Field>
      <Field label="Falta (una por línea)">
        <Textarea className="min-h-16" value={f.missing} onChange={set("missing")} />
      </Field>
      {error && (
        <p role="alert" className="text-fail">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" disabled={busy} onClick={() => void remove()}>
          Eliminar sección
        </Button>
        <span className="flex-1" />
        <Button disabled={busy} onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="primary" disabled={busy || !f.name.trim()} onClick={() => void save()}>
          Guardar
        </Button>
      </div>
    </div>
  );
}

function SectionCard({ s, names, editing, onEdit, onSaved, onDeleted }: { s: Section; names: Map<string, string>; editing: boolean; onEdit: (id: string | null) => void; onSaved: (s: Section) => void; onDeleted: (id: string) => void }) {
  const extra = (
    <>
      {s.missing.length > 0 && <span className="text-xs break-words text-muted-fg">Falta: {s.missing.join(", ")}</span>}
      {s.dependsOn.length > 0 && <span className="text-xs text-muted-fg">Espera a {s.dependsOn.map((id) => names.get(id) ?? "una sección eliminada").join(", ")}</span>}
    </>
  );
  return (
    <div className="px-4 py-3">
      <button type="button" className="block w-full text-left" aria-expanded={editing} onClick={() => onEdit(editing ? null : s.id)}>
        <SectionLine s={s} extra={extra} />
      </button>
      {s.prUrl && (
        <a href={s.prUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block truncate text-xs text-primary">
          Pull request
        </a>
      )}
      {editing && <Editor section={s} onSaved={onSaved} onDeleted={onDeleted} onClose={() => onEdit(null)} />}
    </div>
  );
}

/** The Secciones tab of a project: milestones with search, status filter, inline editor and paging. */
export function ProjectSections({ projectId, store }: { projectId: string; store: SectionsStore }) {
  const { sections, error, changed, deleted, names } = store;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SectionStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const mine = useMemo(() => (sections ?? []).filter((s) => s.projectId === projectId), [sections, projectId]);
  const p = selectSectionPage({ sections: mine, search, status, page, editing });

  async function add() {
    setAddError(null);
    try {
      changed(await call("POST /api/sections", { body: { projectId, name } }));
      setName("");
      setAdding(false);
    } catch (e) {
      setAddError(message(e, "No se pudo agregar"));
    }
  }

  if (error) return <p role="alert" className="text-fail">{error}</p>;
  if (!sections) return <p className="text-muted-fg">Cargando…</p>;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-full flex-1 md:min-w-0 md:max-w-xs" type="search" aria-label="Buscar secciones" placeholder="Buscar" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        <Select className="w-auto" aria-label="Estado" value={status} onChange={(e) => (setStatus(e.target.value as SectionStatus | "all"), setPage(1))}>
          <option value="all">Todas</option>
          {SECTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {sectionStatusLabel(s)}
            </option>
          ))}
        </Select>
        <span className="flex-1" />
        <Button onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          <Plus className="size-4" aria-hidden /> Agregar
        </Button>
      </div>
      {adding && (
        <form
          className="grid gap-2 rounded-card border border-line bg-panel p-3 md:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void add();
          }}
        >
          <Input aria-label="Nombre de la sección" placeholder="Nombre de la sección" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
          <Button variant="primary" type="submit" disabled={!name.trim()}>
            Agregar sección
          </Button>
          {addError && (
            <p role="alert" className="text-fail md:col-span-2">
              {addError}
            </p>
          )}
        </form>
      )}
      {p.total === 0 ? (
        <EmptyState>{mine.length ? "Ninguna sección coincide." : "Nada por acá"}</EmptyState>
      ) : (
        <Panel title="Secciones" count={p.total} action={<Badge>hitos</Badge>}>
          {p.visible.map((s) => (
            <SectionCard key={s.id} s={s} names={names} editing={editing === s.id} onEdit={setEditing} onSaved={changed} onDeleted={deleted} />
          ))}
        </Panel>
      )}
      <Pager page={p} onPageChange={setPage} label="Secciones" />
    </div>
  );
}
