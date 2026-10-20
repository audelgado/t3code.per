import { useCollectionState } from "./collectionHooks.ts";
import { ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useLive } from "./api.ts";
import { ago, projectColor, TONES, type Tone } from "./look.ts";
import { hashes } from "./navigation.ts";
import { EntryAction } from "./Work.tsx";
import { WorkDetail } from "./WorkDetail.tsx";
import { LinkButton } from "./ui/Button.tsx";
import { Input, Select } from "./ui/fields.tsx";
import { buildWork, entryTone, entryWhy, NO_FILTERS, searchWork, type Bucket, type WorkEntry, type WorkFilters } from "./workDirectory.ts";
import { useProjectTitles, useWork } from "./workData.ts";
import { ErrorNote, ProjectTag, Stepper } from "./workUi.tsx";

/** Columns of the board. History ("Sin agente" branches) lives in the Lista, so it has no column. */
const COLUMNS: readonly { bucket: Bucket; label: string; tone: Tone }[] = [
  { bucket: "need", label: "Te necesita", tone: "need" },
  { bucket: "queue", label: "En cola", tone: "queue" },
  { bucket: "run", label: "En curso", tone: "run" },
  { bucket: "pr", label: "PR abierto", tone: "pr" },
  { bucket: "done", label: "Listo", tone: "ok" },
];
/** Finished work is history: only the latest are shown, the Lista has the rest. Every other column shows all of its cards. */
const DONE_SHOWN = 5;

function Card({ entry, onOpen }: { entry: WorkEntry; onOpen: () => void }) {
  const tone = entryTone(entry);
  const why = entryWhy(entry);
  return (
    <article className="relative rounded-[10px] border border-line bg-panel py-2.5 pr-2.5 pl-3.5 [content-visibility:auto] [contain-intrinsic-size:auto_10rem]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 rounded-l-[9px]" style={{ background: projectColor(entry.projectKey) }} />
      <button type="button" onClick={onOpen} className="grid w-full gap-1.5 text-left">
        <span className="flex items-center gap-1.5">
          <ProjectTag projectKey={entry.projectKey} name={entry.projectTitle} className="min-w-0" />
          <span className="ml-auto shrink-0 text-xs text-muted-fg">{ago(entry.updatedAt)}</span>
        </span>
        <span className="text-[13px] font-semibold break-words">{entry.title}</span>
        {why && <span className="text-xs break-words text-muted-fg" style={tone === "need" || tone === "fail" ? { color: TONES[tone].fg } : undefined}>{why}</span>}
        {entry.row && <Stepper stage={entry.row.stage} projectKey={entry.projectKey} tone={tone} />}
      </button>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-fg">{entry.machineLabel}</span>
        <EntryAction entry={entry} onOpen={onOpen} />
      </div>
    </article>
  );
}

/** Trabajo / Tablero: the same entries as the Lista in five columns. Read and act; no drag and drop. */
export function Board() {
  const { view } = useLive();
  const { machines: work, error } = useWork();
  const titles = useProjectTitles();
  const [filters, setFilters] = useCollectionState<WorkFilters>("board.filters", NO_FILTERS, (f) => ["all", "need", "run", "queue", "done"].includes(f.tab));
  const [column, setColumn] = useCollectionState<Bucket>("board.column", "need", (v) => COLUMNS.some((c) => c.bucket === v));
  const [selected, setSelected] = useState<string | null>(null);

  const entries = useMemo(() => {
    if (!view) return [];
    const threads = [...view.needsYou.flatMap((n) => (n.kind === "thread" ? [n.thread] : [])), ...view.running, ...view.done];
    return buildWork({ queue: view.queue, work: work ?? [], machines: view.machines.map((m) => ({ id: m.id, label: m.label, status: m.link.status })), threads });
  }, [view, work]);
  if (!view) return null;

  const found = searchWork(entries, filters);
  const projects = [...new Map(entries.map((e) => [e.projectKey, titles.get(e.projectKey) ?? e.projectTitle])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const current = entries.find((e) => e.key === selected) ?? null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap gap-2 md:justify-end">
        <Input type="search" aria-label="Buscar trabajo" placeholder="Buscar tarea, proyecto o rama…" className="md:w-64" value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} />
        <Select aria-label="Filtrar por proyecto" className="min-w-[15rem] flex-1 md:w-auto md:min-w-0 md:flex-none" value={filters.projectKey} onChange={(e) => setFilters({ ...filters, projectKey: e.target.value })}>
          <option value="">Todos los proyectos</option>
          {projects.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        </Select>
        <Select aria-label="Filtrar por máquina" className="min-w-[15rem] flex-1 md:w-auto md:min-w-0 md:flex-none" value={filters.machineId} onChange={(e) => setFilters({ ...filters, machineId: e.target.value })}>
          <option value="">Todas las máquinas</option>
          {view.machines.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </Select>
      </div>
      {error && <ErrorNote>No se pudo cargar las ramas. {error}</ErrorNote>}

      <div role="group" aria-label="Columna" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 md:hidden">
        {COLUMNS.map((c) => {
          const on = c.bucket === column;
          return (
            <button
              key={c.bucket}
              type="button"
              aria-pressed={on}
              onClick={() => setColumn(c.bucket)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-line bg-panel px-3 text-[13px] font-semibold text-tx2"
              style={on ? { background: TONES[c.tone].fg, borderColor: TONES[c.tone].fg, color: "#fff" } : undefined}
            >
              {c.label} <span className="opacity-75">{found.filter((e) => e.bucket === c.bucket).length}</span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 md:auto-cols-[minmax(220px,1fr)] md:grid-flow-col md:overflow-x-auto md:pb-1">
        {COLUMNS.map((c) => {
          const items = found.filter((e) => e.bucket === c.bucket);
          const shown = c.bucket === "done" ? items.slice(0, DONE_SHOWN) : items;
          return (
            <section
              key={c.bucket}
              aria-label={c.label}
              className={`min-w-0 flex-col rounded-xl bg-side ${c.bucket === column ? "flex" : "hidden"} md:flex`}
            >
              <h2 className="flex items-center gap-2 px-3 pt-2.5 pb-2 text-[13px] font-semibold">
                <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: TONES[c.tone].fg }} />
                {c.label}
                <span className="ml-auto text-xs font-semibold text-muted-fg tabular-nums">{items.length}</span>
              </h2>
              <div className="grid content-start gap-2 px-2 pb-2 md:max-h-[calc(100dvh-14rem)] md:overflow-y-auto">
                {shown.map((e) => <Card key={e.key} entry={e} onOpen={() => setSelected(e.key)} />)}
                {items.length === 0 && <p className="px-2 py-5 text-center text-[13px] text-muted-fg">Sin elementos</p>}
                {c.bucket === "done" && items.length > 0 && (
                  <LinkButton variant="outline" size="sm" href={hashes.page("work")} className="border-dashed bg-transparent text-muted-fg">
                    Historial <ChevronRight className="size-4" aria-hidden />
                  </LinkButton>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {current && <WorkDetail key={current.key} entry={current} variant="sheet" onClose={() => setSelected(null)} />}
    </div>
  );
}
