import { WifiOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LinkStatus } from "../../server/types.ts";
import { useLive } from "./api.ts";
import { ago, projectColor, stageLabel, statusTone, TONES } from "./look.ts";
import { hashes } from "./navigation.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Chip, StatusChip } from "./ui/Chip.tsx";
import { EmptyState, Input, Select } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Tabs } from "./ui/Tabs.tsx";
import { toast } from "./ui/Toast.tsx";
import { useIsPhone } from "./ui/useIsPhone.ts";
import { BUCKET_LABEL, BUCKET_TONE, buildWork, entryAction, entryTone, entryWhy, groupByBucket, NO_FILTERS, searchWork, tabCounts, tidyLanes, WORK_TABS, workPage, type WorkEntry, type WorkFilters, type WorkTab } from "./workDirectory.ts";
import { askTidy, taskCall, useAct, useProjectTitles, useWork } from "./workData.ts";
import { WorkDetail } from "./WorkDetail.tsx";
import { ErrorNote, GroupHeader, ProjectTag, Stepper } from "./workUi.tsx";

const HISTORY_PAGE = 8;

/** Action cell: the primary action, or the status when there is nothing to do. */
export function EntryAction({ entry, onOpen }: { entry: WorkEntry; onOpen: () => void }) {
  const action = entryAction(entry);
  const { busy, error, act } = useAct();
  if (!action) return entry.task ? <StatusChip status={entry.task.status} /> : <Chip tone={BUCKET_TONE[entry.bucket]}>{BUCKET_LABEL[entry.bucket]}</Chip>;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  switch (action.kind) {
    case "thread":
      return <LinkButton size="sm" variant="primary" href={hashes.thread(entry.thread!.key)} onClick={stop}>{action.label}</LinkButton>;
    case "pr":
      return <LinkButton size="sm" variant="outline" href={action.href} target="_blank" rel="noreferrer" onClick={stop}>{action.label}</LinkButton>;
    case "retry":
      return (
        <>
          <Button size="sm" disabled={busy} onClick={(e) => { stop(e); void act("No se pudo reintentar", () => taskCall.retry(entry.task!.id)); }}>{action.label}</Button>
          {error && <span role="alert" className="mt-1 block text-[11.5px] leading-tight text-fail">{error}</span>}
        </>
      );
    default:
      return <Button size="sm" variant="primary" onClick={(e) => { stop(e); onOpen(); }}>{action.label}</Button>;
  }
}

function EntryRow({ entry, selected, onSelect }: { entry: WorkEntry; selected: boolean; onSelect: () => void }) {
  const r = entry.row;
  const tone = entryTone(entry);
  const why = entryWhy(entry);
  const stage = r ? (
    <>
      <Stepper stage={r.stage} projectKey={entry.projectKey} tone={tone} />
      <span className="mt-1 block truncate text-xs" style={{ color: tone === "fail" ? TONES.fail.fg : undefined }}>
        {stageLabel(r.stage)}{tone === "fail" ? " · falló" : ""}
      </span>
    </>
  ) : (
    <span className="block truncate text-xs text-muted-fg">{why || (entry.bucket === "queue" ? "Sin iniciar" : statusLabel(entry))}</span>
  );
  return (
    <li className={`relative border-b border-soft last:border-b-0 ${selected ? "bg-[#f5f8ff]" : ""}`}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ background: projectColor(entry.projectKey) }} />
      <div className="flex items-center gap-3 py-2.5 pr-3 pl-4 md:grid md:min-h-[58px] md:grid-cols-[minmax(0,1fr)_150px_76px_112px] md:gap-4 md:py-2 md:pr-5 md:pl-5">
        <button type="button" aria-pressed={selected} onClick={onSelect} className="min-w-0 flex-1 text-left">
          <span className="block truncate font-semibold">{entry.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-fg">
            <ProjectTag projectKey={entry.projectKey} name={entry.projectTitle} className="shrink-0 max-w-[40%]" />
            <span className="truncate">{entry.machineLabel}</span>
            {r && <span className="hidden truncate font-mono md:inline">{r.branch}</span>}
          </span>
          <span className="mt-1 block md:hidden">{stage}</span>
        </button>
        <div className="hidden min-w-0 md:block">{stage}</div>
        <span className="hidden text-[13px] text-muted-fg md:block">{ago(entry.updatedAt)}</span>
        <div className="shrink-0 md:text-right"><EntryAction entry={entry} onOpen={onSelect} /></div>
      </div>
    </li>
  );
}

const statusLabel = (e: WorkEntry) => (e.task ? statusTone(e.task.status).label : BUCKET_LABEL[e.bucket]);

function Offline({ label, status }: { label: string; status: LinkStatus }) {
  return (
    <p className="flex items-center gap-2 rounded-ctl bg-need-bg px-3 py-2 text-[13px] text-[#7c3d06]">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <span><b>{label}: {statusTone(status).label.toLowerCase()}.</b> Mostrando lo último que informó T3.</span>
    </p>
  );
}

function TidyRow({ lane }: { lane: ReturnType<typeof tidyLanes>[number] }) {
  const { busy, error, act } = useAct();
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <ProjectTag projectKey={lane.projectKey} name={lane.title} className="font-semibold text-fg" />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-fg">{lane.machineLabel} · {lane.count} {lane.count === 1 ? "rama mergeada o abandonada" : "ramas mergeadas o abandonadas"}</span>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void act("No se pudo pedir la limpieza", async () => {
              const task = await askTidy(lane.machineId, lane.projectId);
              toast("Se encoló la tarea de limpieza.", { label: "Ver", onClick: () => (location.hash = hashes.task(task.id)) });
            })
          }
        >
          Pedir limpieza
        </Button>
      </div>
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
    </div>
  );
}

/** Trabajo / Lista: every task and branch grouped by what you do with it, with a detail drawer. `taskId` (push links) opens a task. */
export function Work({ taskId }: { taskId: string | null }) {
  const { view } = useLive();
  const { machines: work, error } = useWork();
  const titles = useProjectTitles();
  const phone = useIsPhone();
  const [filters, setFilters] = useState<WorkFilters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(taskId ? `task:${taskId}` : null);
  useEffect(() => setSelected(taskId ? `task:${taskId}` : null), [taskId]);

  const threads = useMemo(() => (view ? [...view.needsYou.flatMap((n) => (n.kind === "thread" ? [n.thread] : [])), ...view.running, ...view.done] : []), [view]);
  const entries = useMemo(
    () =>
      view
        ? buildWork({ queue: view.queue, work: work ?? [], machines: view.machines.map((m) => ({ id: m.id, label: m.label, status: m.link.status })), threads })
        : [],
    [view, work, threads],
  );
  if (!view) return null;

  const set = (patch: Partial<WorkFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const found = searchWork(entries, filters);
  const counts = tabCounts(found);
  const { actionable, history } = workPage(found, filters.tab, page, HISTORY_PAGE);
  const projects = [...new Map(entries.map((e) => [e.projectKey, titles.get(e.projectKey) ?? e.projectTitle])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const lanes = tidyLanes(work ?? []).filter((l) => (!filters.projectKey || l.projectKey === filters.projectKey) && (!filters.machineId || l.machineId === filters.machineId));
  const showTidy = lanes.length > 0 && (filters.tab === "all" || filters.tab === "done");
  const current = entries.find((e) => e.key === selected) ?? null;
  const offline = view.machines.filter((m) => m.link.status !== "online" && (!filters.machineId || m.id === filters.machineId));
  const groups = [...actionable, ...groupByBucket(history.items)];
  // Also drops `?task=` from the hash, or opening the same task again by link would not change it.
  const close = () => {
    setSelected(null);
    if (taskId) location.replace(hashes.page("work"));
  };
  const select = (e: WorkEntry) => setSelected(e.key === selected ? null : e.key);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs label="Filtrar trabajo" value={filters.tab} onChange={(tab: WorkTab) => set({ tab })} items={WORK_TABS.map(([id, label]) => ({ id, label, count: counts[id] }))} />
        <div className="flex w-full flex-wrap gap-2 md:ml-auto md:w-auto">
          <Input type="search" aria-label="Buscar trabajo" placeholder="Buscar tarea, proyecto o rama" className="md:w-64" value={filters.query} onChange={(e) => set({ query: e.target.value })} />
          <Select aria-label="Filtrar por proyecto" className="min-w-[15rem] flex-1 md:w-auto md:min-w-0 md:flex-none" value={filters.projectKey} onChange={(e) => set({ projectKey: e.target.value })}>
            <option value="">Todos los proyectos</option>
            {projects.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
          </Select>
          <Select aria-label="Filtrar por máquina" className="min-w-[15rem] flex-1 md:w-auto md:min-w-0 md:flex-none" value={filters.machineId} onChange={(e) => set({ machineId: e.target.value })}>
            <option value="">Todas las máquinas</option>
            {view.machines.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </div>
      </div>

      {offline.map((m) => <Offline key={m.id} label={m.label} status={m.link.status} />)}
      {error && <ErrorNote>No se pudo cargar las ramas. {error}</ErrorNote>}
      {showTidy && <Panel title="Para limpiar" count={lanes.length}>{lanes.map((l) => <TidyRow key={l.projectKey} lane={l} />)}</Panel>}

      <div className="flex items-start overflow-clip rounded-card border border-line bg-panel">
        <div className="min-w-0 flex-1">
          {groups.length === 0 && (
            <div className="p-4">
              <EmptyState action={filters.query || filters.projectKey || filters.machineId || filters.tab !== "all" ? <Button size="sm" onClick={() => { setFilters(NO_FILTERS); setPage(1); }}>Limpiar filtros</Button> : undefined}>
                {work === null && !error ? "Cargando…" : "Nada por acá"}
              </EmptyState>
            </div>
          )}
          {groups.map((g) => (
            <section key={g.bucket}>
              <GroupHeader tone={BUCKET_TONE[g.bucket]} label={BUCKET_LABEL[g.bucket]} count={g.items.length} />
              <ul>{g.items.map((e) => <EntryRow key={e.key} entry={e} selected={e.key === selected} onSelect={() => select(e)} />)}</ul>
            </section>
          ))}
          {work === null && !error && groups.length > 0 && <p className="px-4 py-2 text-xs text-muted-fg">Cargando ramas…</p>}
          {history.pageCount > 1 && <div className="px-4 py-3 md:px-5"><Pager page={history} onPageChange={setPage} label="Historial" /></div>}
        </div>
        {current && !phone && <WorkDetail key={current.key} entry={current} variant="aside" onClose={close} />}
      </div>
      {current && phone && <WorkDetail key={current.key} entry={current} variant="sheet" onClose={close} />}
    </div>
  );
}
