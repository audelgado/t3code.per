import { Check, ChevronRight, Clock, Inbox, Play } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { HomeView, TaskItem, ThreadItem } from "../../server/types.ts";
import type { WorkRow } from "../../server/work.ts";
import { useLive } from "./api.ts";
import { homeCounts, homeNeeds, type HomeNeed } from "./homeQueueView.ts";
import { ago, at, priorityLabel, TONES, type Tone } from "./look.ts";
import { hashes, pages } from "./navigation.ts";
import { paginateCollection } from "./pagination.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { EmptyState, Section } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Panel } from "./ui/Panel.tsx";
import { taskCall, useAct, useProjectTitles, useWork } from "./workData.ts";
import { ErrorNote, ProjectTag, Stepper } from "./workUi.tsx";

const DONE_PAGE = 5;
const QUEUE_SHOWN = 5;

function Figure({ href, tone, icon, count, label }: { href: string; tone: Tone; icon: ReactNode; count: number; label: string }) {
  const { fg, bg } = TONES[tone];
  return (
    <a href={href} className="flex items-center gap-3 rounded-card border border-line bg-panel px-3.5 py-3 active:bg-soft">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[9px]" style={{ background: bg, color: fg }}>
        {icon}
      </span>
      <span>
        <span className="block text-[22px] leading-tight font-bold tabular-nums" style={{ color: fg }}>{count}</span>
        <span className="block text-[13px] text-muted-fg">{label}</span>
      </span>
    </a>
  );
}

function NeedRow({ n }: { n: HomeNeed }) {
  const { busy, error, act } = useAct();
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: TONES[n.tone].fg }} />
        <a href={n.href} className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{n.title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-fg">
            {n.projectKey && n.project ? <ProjectTag projectKey={n.projectKey} name={n.project} className="max-w-[40%] shrink-0" /> : n.project && <span className="shrink-0">{n.project}</span>}
            {n.why && <span className="truncate" style={n.tone === "fail" && !n.alert ? { color: TONES.fail.fg } : undefined}>{(n.project ? "· " : "") + n.why}</span>}
            <span className="shrink-0">· {ago(n.since)}</span>
          </span>
        </a>
        {"retry" in n.action ? (
          <Button size="sm" disabled={busy} onClick={() => void act("No se pudo reintentar", () => taskCall.retry((n.action as { retry: string }).retry))}>
            {n.action.label}
          </Button>
        ) : (
          <LinkButton size="sm" variant={n.alert ? "outline" : "primary"} href={n.action.href}>{n.action.label}</LinkButton>
        )}
      </div>
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
    </div>
  );
}

function RunningRow({ t, name, machine, row }: { t: ThreadItem; name: string; machine: string; row: WorkRow | undefined }) {
  const key = `${t.machineId}:${t.projectId}`;
  return (
    <a href={hashes.thread(t.key)} className="flex items-center gap-3 px-4 py-3 active:bg-soft">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{t.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-fg">
          <ProjectTag projectKey={key} name={name} className="shrink-0 max-w-[45%]" />
          <span className="truncate">· {t.waitingUntil ? `Esperando hasta ${at(t.waitingUntil)}` : machine} · {ago(t.updatedAt)}</span>
        </span>
      </span>
      {row ? <Stepper stage={row.stage} projectKey={key} tone="run" /> : <Chip tone="run">En curso</Chip>}
    </a>
  );
}

function QueuedRow({ t, offline }: { t: TaskItem; offline: boolean }) {
  const why = t.queueReason ?? (t.blockedBy.length ? `Espera a ${t.blockedBy.length} tarea${t.blockedBy.length === 1 ? "" : "s"}` : offline ? `Esperando a ${t.machineLabel}` : t.machineLabel);
  return (
    <a href={hashes.task(t.id)} className="flex items-center gap-3 px-4 py-2.5 active:bg-soft">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{t.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted-fg">
          <ProjectTag projectKey={`${t.machineId}:${t.projectId}`} name={t.projectTitle} className="shrink-0 max-w-[45%]" />
          <span className="truncate">· {why}</span>
        </span>
      </span>
      {t.priority !== 0 && <Chip tone={t.priority > 0 ? "need" : "queue"}>{priorityLabel(t.priority)}</Chip>}
    </a>
  );
}

/** Hoy: what needs you (never paged), what is moving, what waits, what finished (paged). Rows open the overlay through `#item=<key>`. */
export function Home() {
  const { view } = useLive();
  if (!view) return null;
  return <Today view={view} />;
}

function Today({ view }: { view: HomeView }) {
  const { machines: work } = useWork();
  const titles = useProjectTitles();
  const [donePage, setDonePage] = useState(1);

  const needs = useMemo(
    () => homeNeeds(view, { projectTitle: (k) => titles.get(k), hashes: { thread: hashes.thread, task: hashes.task, run: hashes.run, fleet: hashes.page("fleet") } }),
    [view, titles, titles.size],
  );
  const counts = homeCounts(view, needs.length);
  const rows = useMemo(() => {
    const byUrl = new Map<string, WorkRow>();
    const byTask = new Map<string, WorkRow>();
    for (const m of work ?? []) for (const lane of m.lanes) for (const r of lane.rows) (byUrl.set(r.appUrl, r), r.taskId && byTask.set(r.taskId, r));
    return (t: ThreadItem) => byUrl.get(t.appUrl) ?? (t.taskId ? byTask.get(t.taskId) : undefined);
  }, [work]);

  const machine = (id: string) => view.machines.find((m) => m.id === id);
  const projectName = (t: ThreadItem) => titles.get(`${t.machineId}:${t.projectId}`) ?? machine(t.machineId)?.label ?? "";
  const queued = view.queue.filter((t) => t.status === "queued");
  const done = paginateCollection(view.done, donePage, DONE_PAGE);

  return (
    <div className="grid gap-4 md:gap-5">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
        <Figure href={hashes.page("work")} tone="need" icon={<Inbox className="size-[18px]" />} count={counts.needs} label="Te necesita" />
        <Figure href={hashes.page("board")} tone="run" icon={<Play className="size-[18px]" />} count={counts.running} label="En marcha" />
        <Figure href={hashes.page("work")} tone="queue" icon={<Clock className="size-[18px]" />} count={counts.queued} label="En cola" />
        <Figure href={hashes.page("work")} tone="ok" icon={<Check className="size-[18px]" />} count={counts.done} label="Terminado hoy" />
      </div>

      <div className="grid items-start gap-4 md:gap-5 lg:grid-cols-[1.3fr_1fr]">
        {needs.length === 0 ? (
          <Section title="Te necesita" count={0}>
            <EmptyState action={<LinkButton size="sm" href={hashes.page("board")}>Ver qué está en marcha</LinkButton>}>Nada por acá</EmptyState>
          </Section>
        ) : (
          <Panel title="Te necesita" count={needs.length} action={<span className="text-xs text-muted-fg">más antiguo primero</span>}>
            {needs.map((n) => <NeedRow key={n.key} n={n} />)}
          </Panel>
        )}

        <div className="grid gap-4 md:gap-5">
          {view.running.length === 0 ? (
            <Section title="En marcha" count={0}>
              <EmptyState>Nada por acá</EmptyState>
            </Section>
          ) : (
            <Panel
              title="En marcha"
              count={view.running.length}
              action={<LinkButton size="sm" variant="ghost" href={hashes.page("board")}>Tablero <ChevronRight className="size-4" aria-hidden /></LinkButton>}
            >
              {view.running.map((t) => <RunningRow key={t.key} t={t} name={projectName(t)} machine={machine(t.machineId)?.label ?? ""} row={rows(t)} />)}
            </Panel>
          )}

          {queued.length > 0 && (
            <Panel title="En cola" count={queued.length}>
              {queued.slice(0, QUEUE_SHOWN).map((t) => <QueuedRow key={t.id} t={t} offline={machine(t.machineId)?.link.status !== "online"} />)}
              {queued.length > QUEUE_SHOWN && (
                <a href={hashes.page("work")} className="block px-4 py-2.5 text-[13px] text-muted-fg active:bg-soft">
                  Ver las {queued.length - QUEUE_SHOWN} restantes en {pages.work.title}
                </a>
              )}
            </Panel>
          )}
        </div>
      </div>

      <Panel title="Terminado hoy" count={view.done.length}>
        {view.done.length === 0 && <p className="px-4 py-6 text-center text-muted-fg">Nada por acá</p>}
        {done.items.map((t) => (
          <a key={t.key} href={hashes.thread(t.key)} className="flex items-center gap-3 px-4 py-3 active:bg-soft">
            <StatusDot status={t.failed ? "failed" : "completed"} />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t.title}</span>
              <span className="block truncate text-[12.5px] text-muted-fg">{t.preview ?? projectName(t)}</span>
            </span>
            <span className="shrink-0 text-xs text-muted-fg">{ago(t.updatedAt)}</span>
          </a>
        ))}
        {done.pageCount > 1 && <div className="px-4 pb-3"><Pager page={done} onPageChange={setDonePage} label="Terminado hoy" /></div>}
      </Panel>
      {(view.running.length >= 50 || view.done.length >= 30) && <p className="text-xs text-muted-fg">Se muestran hasta 50 hilos en marcha y los 30 terminados más recientes de las últimas 24 horas.</p>}
    </div>
  );
}
