import { FileText, Pin, PinOff, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Artifact } from "../../server/artifacts.ts";
import type { MemoryEntry } from "../../server/memory.ts";
import type { HomeView } from "../../server/types.ts";
import { call } from "./api.ts";
import { Artifacts } from "./Artifacts.tsx";
import { memoryKindLabel, projectColor, type Tone } from "./look.ts";
import { Memory } from "./Memory.tsx";
import { hashes, PROJECT_TABS, type ProjectTab } from "./navigation.ts";
import { projectWork, splitProjectKey, type ProjectEntry } from "./projectDirectory.ts";
import { ProjectSections, SectionLine, useSections } from "./Sections.tsx";
import { ProjectChat } from "./ProjectChat.tsx";
import { ProjectPlan } from "./ProjectPlan.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Chip, StatusChip } from "./ui/Chip.tsx";
import { ago } from "./ui/cn.ts";
import { EmptyState } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Avatar } from "./ui/ProjectDot.tsx";
import { Tabs } from "./ui/Tabs.tsx";
import { paginateCollection } from "./pagination.ts";

const memoryTone: Record<string, Tone> = { progress: "run", decision: "pr", todo: "need", handoff: "teal", note: "queue" };
const reasonAction = { approval: "Aprobar", input: "Responder", plan: "Revisar plan" } as const;
const DONE_PAGE = 8;

function Line({ href, title, sub, right }: { href: string; title: string; sub?: string | null; right?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <a href={href} className="grid min-w-0 flex-1">
        <span className="truncate font-semibold">{title}</span>
        {sub && <span className="truncate text-xs text-muted-fg">{sub}</span>}
      </a>
      {right}
    </div>
  );
}

type Work = ReturnType<typeof projectWork>;

/** Rows for what needs you, what runs and what waits. Actionable, so never paged. */
function needsRows(work: Work) {
  return work.needs.map((n) =>
    n.kind === "thread" ? (
      <Line
        key={n.thread.key}
        href={hashes.thread(n.thread.key)}
        title={n.thread.title}
        sub={n.thread.pending?.summary ?? ago(n.since)}
        right={<LinkButton size="sm" variant="primary" href={hashes.thread(n.thread.key)}>{reasonAction[n.reason]}</LinkButton>}
      />
    ) : n.kind === "task_approval" ? (
      <Line
        key={n.task.id}
        href={hashes.task(n.task.id)}
        title={n.task.title}
        sub={n.task.source.startsWith("agent:") ? `${n.task.source.slice(6)} quiere encolar esta tarea` : "Tarea por aprobar"}
        right={<LinkButton size="sm" variant="primary" href={hashes.task(n.task.id)}>Aprobar</LinkButton>}
      />
    ) : null,
  );
}
const runningRows = (work: Work) =>
  work.running.map((t) => <Line key={t.key} href={hashes.thread(t.key)} title={t.title} sub={ago(t.updatedAt)} right={<StatusChip status={t.status} />} />);
const queuedRows = (work: Work) =>
  work.queued.map((t) => <Line key={t.id} href={hashes.task(t.id)} title={t.title} sub={t.blockedBy.length ? "Espera a otra tarea" : ago(t.updatedAt)} right={<StatusChip status={t.status} />} />);

function WorkTab({ work }: { work: Work }) {
  const [page, setPage] = useState(1);
  const done = paginateCollection(work.done, page, DONE_PAGE);
  useEffect(() => setPage(done.page), [done.page]);
  if (work.open === 0 && work.done.length === 0) return <EmptyState>Sin elementos</EmptyState>;
  return (
    <div className="grid gap-4">
      {work.needs.length > 0 && <Panel title="Te necesita" count={work.needs.length}>{needsRows(work)}</Panel>}
      {work.running.length > 0 && <Panel title="En marcha" count={work.running.length}>{runningRows(work)}</Panel>}
      {work.queued.length > 0 && <Panel title="En cola" count={work.queued.length}>{queuedRows(work)}</Panel>}
      {work.done.length > 0 && (
        <div className="grid gap-3">
          <Panel title="Terminado hoy" count={work.done.length}>
            {done.items.map((t) => (
              <Line key={t.key} href={hashes.thread(t.key)} title={t.title} sub={t.preview ?? ago(t.updatedAt)} right={<StatusChip status={t.failed ? "failed" : "done"} />} />
            ))}
          </Panel>
          <Pager page={done} onPageChange={setPage} label="Terminado hoy" />
        </div>
      )}
    </div>
  );
}

function seeAll(href: string) {
  return (
    <a href={href} className="text-sm text-muted-fg">
      Ver todo ›
    </a>
  );
}

/** Project detail: header, the five tabs, and each tab's content. Route #project/<machineId:projectId>[?tab=...]. */
export function ProjectDetail({ entry, tab, view, pinned, onTogglePin }: { entry: ProjectEntry; tab: ProjectTab; view: HomeView | null; pinned: boolean; onTogglePin: () => void }) {
  const { projectId } = splitProjectKey(entry.key);
  const sections = useSections();
  const [revision, setRevision] = useState(0);
  const [memory, setMemory] = useState<{ entries: MemoryEntry[]; hasMore: boolean } | null>(null);
  const [artifacts, setArtifacts] = useState<{ artifacts: Artifact[]; hasMore: boolean } | null>(null);
  useEffect(() => {
    call("POST /api/memory/list", { body: { projectId, limit: 50 } }).then(setMemory, () => {});
    call("POST /api/artifacts/list", { body: { projectId, archived: false, limit: 50 } }).then(setArtifacts, () => {});
  }, [projectId, tab, revision]);

  const work = useMemo(() => projectWork(view, entry.key), [view, entry.key]);
  const mine = useMemo(() => (sections.sections ?? []).filter((s) => s.projectId === projectId), [sections.sections, projectId]);
  // A count is exact only when the whole list fit in one request.
  const counts: Partial<Record<ProjectTab, number>> = {
    work: work.open,
    sections: sections.sections ? mine.length : undefined,
    artifacts: artifacts && !artifacts.hasMore ? artifacts.artifacts.length : undefined,
    memory: memory && !memory.hasMore ? memory.entries.length : undefined,
  };
  const online = entry.machine.status === "online";
  const href = (t: ProjectTab) => hashes.project(entry.key, t);

  return (
    <div className="grid gap-4">
      <div aria-hidden className="h-1 rounded-full" style={{ background: projectColor(entry.key) }} />
      <header className="flex flex-wrap items-center gap-3">
        <Avatar name={entry.title} projectKey={entry.key} className="hidden md:inline-grid" />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{entry.title}</h1>
            <Button variant="ghost" size="icon" aria-pressed={pinned} aria-label={pinned ? `Desfijar ${entry.title}` : `Fijar ${entry.title}`} onClick={onTogglePin}>
              {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            </Button>
          </div>
          <p className="flex min-w-0 items-center gap-2 text-xs text-muted-fg">
            <StatusDot status={entry.machine.status} />
            <span className="shrink-0">{entry.machine.machineLabel}</span>
            <code className="min-w-0 truncate font-mono" title={entry.path}>{entry.path}</code>
          </p>
          {!online && <p className="text-xs text-need">La máquina no está en línea: se muestra lo último que informó.</p>}
        </div>
        {tab !== "chat" && <LinkButton variant="primary" className="w-full md:w-auto" href={hashes.project(entry.key, "chat")}>
          <Sparkles className="size-4" aria-hidden /> Abrir chat
        </LinkButton>}
      </header>

      <Tabs label="Secciones del proyecto" value={tab} items={PROJECT_TABS.map(([id, label]) => ({ id, label, count: counts[id], href: href(id) }))} />

      {tab === "chat" && <ProjectChat key={entry.key} projectKey={entry.key} />}

      {(tab === "overview" || tab === "plan") && <ProjectPlan key={entry.key} projectKey={entry.key} store={sections} compact={tab === "overview"} onChanged={() => setRevision((r) => r + 1)} />}

      {tab === "overview" && (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="grid gap-4">
            <Panel title="Trabajo abierto" count={work.open} action={seeAll(href("work"))}>
              {work.open === 0 ? (
                <p className="px-4 py-3 text-muted-fg">Sin trabajo abierto</p>
              ) : (
                [...needsRows(work), ...runningRows(work), ...queuedRows(work)].slice(0, 5)
              )}
            </Panel>
            <Panel title="Secciones" count={sections.sections ? mine.length : undefined} action={seeAll(href("sections"))}>
              {sections.error ? (
                <p className="px-4 py-3 text-fail">{sections.error}</p>
              ) : mine.length === 0 ? (
                <p className="px-4 py-3 text-muted-fg">{sections.sections ? "Sin elementos" : "Cargando…"}</p>
              ) : (
                mine.slice(0, 4).map((s) => (
                  <a key={s.id} href={href("sections")} className="block px-4 py-3">
                    <SectionLine s={s} />
                  </a>
                ))
              )}
            </Panel>
          </div>
          <div className="grid gap-4">
            <Panel title="Memoria" action={seeAll(href("memory"))}>
              {!memory || memory.entries.length === 0 ? (
                <p className="px-4 py-3 text-muted-fg">{memory ? "Sin elementos" : "Cargando…"}</p>
              ) : (
                memory.entries.slice(0, 3).map((e) => (
                  <a key={e.id} href={href("memory")} className="flex items-start gap-3 px-4 py-3">
                    <Chip tone={memoryTone[e.kind] ?? "queue"} className="min-w-[5.5rem] shrink-0 justify-center">{memoryKindLabel(e.kind)}</Chip>
                    <span className="grid min-w-0 flex-1">
                      <span className="line-clamp-2 break-words">{e.text}</span>
                      <span className="text-xs text-muted-fg">
                        {e.source === "user" ? "tú" : e.source === "agent" ? "agente" : "sistema"} · {ago(e.createdAt)}
                      </span>
                    </span>
                  </a>
                ))
              )}
            </Panel>
            <Panel title="Artefactos" action={seeAll(href("artifacts"))}>
              {!artifacts || artifacts.artifacts.length === 0 ? (
                <p className="px-4 py-3 text-muted-fg">{artifacts ? "Sin elementos" : "Cargando…"}</p>
              ) : (
                artifacts.artifacts.slice(0, 3).map((a) => (
                  <a key={a.id} href={href("artifacts")} className="flex items-center gap-3 px-4 py-3">
                    <FileText className="size-4 shrink-0 text-muted-fg" aria-hidden />
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate font-semibold">{a.title}</span>
                      <span className="text-xs text-muted-fg">
                        {a.kind === "html" ? "HTML" : "Markdown"} · v{a.currentVersion} · {ago(a.updatedAt)}
                      </span>
                    </span>
                  </a>
                ))
              )}
            </Panel>
          </div>
        </div>
      )}
      {tab === "work" && <WorkTab work={work} />}
      {tab === "sections" && <ProjectSections projectId={projectId} store={sections} />}
      {tab === "artifacts" && <Artifacts projectKey={entry.key} />}
      {tab === "memory" && <Memory projectKey={entry.key} />}
    </div>
  );
}
