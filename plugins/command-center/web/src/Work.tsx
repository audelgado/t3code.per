import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkApi, WorkLane, WorkMachine, WorkRow } from "../../server/work.ts";
import { workDirectory, type WorkFilters } from "./workDirectory.ts";
import { paginateCollection } from "./pagination.ts";
import { Pager } from "./ui/Pager.tsx";
import { call, refresh } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Input, Select } from "./ui/fields.tsx";

// ponytail: typed through this cast until the routes are merged into Api (server/types.ts).
const api = call as unknown as <R extends keyof WorkApi>(route: R, opts?: { body?: WorkApi[R]["body"] }) => Promise<WorkApi[R]["res"]>;

/** Mirrors STAGES in server/work.ts (a value import would pull server code into the bundle). */
const STAGES = ["Created", "Working", "Committed", "Pushed", "PR open", "Merged", "Cleanup"];

/** Matches the server's cache window, so a poll never finds a fresh read pending. */
const POLL_MS = 30_000;

type TidyState = { label: string; busy: boolean; msg: { ok: boolean; text: string } | null };

/** Branches and PRs per project, grouped by machine. Reads only while mounted and the page is visible. */
export function Work() {
  const [machines, setMachines] = useState<WorkMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<WorkFilters>({ query: "", machineId: "", status: "all" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(5);
  // Keep in-flight actions and feedback when filters/pages unmount a lane.
  const [tidyStates, setTidyStates] = useState<Record<string, TidyState>>({});
  async function askTidy(machineId: string, machineLabel: string, lane: WorkLane) {
    const key = `${machineId}:${lane.projectId}`;
    const label = `${machineLabel} / ${lane.title}`;
    setTidyStates((states) => ({ ...states, [key]: { label, busy: true, msg: null } }));
    let msg: TidyState["msg"];
    try {
      await api("POST /api/work/tidy", { body: { machineId, projectId: lane.projectId } });
      refresh();
      msg = { ok: true, text: "Tidy task queued." };
    } catch (e) {
      msg = { ok: false, text: e instanceof Error ? e.message : "Failed" };
    }
    setTidyStates((states) => ({ ...states, [key]: { label, busy: false, msg } }));
  }
  const filter = (patch: Partial<WorkFilters>) => {
    setFilters((value) => ({ ...value, ...patch }));
    setPage(1);
  };

  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(timer);
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      api("GET /api/work")
        .then(
          (m) => {
            if (!live) return;
            setMachines(m);
            setError(null);
          },
          (e: unknown) => {
            if (live) setError(e instanceof Error ? e.message : "Could not load");
          },
        )
        .finally(() => {
          busy = false;
          if (live) timer = setTimeout(load, POLL_MS);
        });
    };
    load();
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const directory = workDirectory(machines ?? [], filters, page, size);
  const currentPage = directory.pagination.page;
  useEffect(() => {
    setPage(currentPage);
  }, [currentPage]);
  const filterKey = JSON.stringify(filters);
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Work</h1>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input type="search" aria-label="Search work" placeholder="Search name, project or branch" value={filters.query} onChange={(e) => filter({ query: e.target.value })} />
        <Select aria-label="Filter work by machine" value={filters.machineId} onChange={(e) => filter({ machineId: e.target.value })}>
          <option value="">All machines</option>
          {machines?.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </Select>
        <Select aria-label="Filter work by status" value={filters.status} onChange={(e) => filter({ status: e.target.value as WorkFilters["status"] })}>
          <option value="all">All work</option><option value="active">Active</option><option value="tidy">Needs tidy</option><option value="pr">With PR</option>
        </Select>
        <Select aria-label="Work projects per page" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>
          {[5, 20, 50].map((n) => <option key={n} value={n}>{n} projects per page</option>)}
        </Select>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {machines === null && !error && <p className="text-muted-fg">Loading...</p>}
      {directory.machines.filter((m) => m.status !== "online").map((m) => (
        <p key={m.id} className="flex items-center gap-2 text-muted-fg">
          <StatusDot status={m.status} /> {m.label}: {m.status}: showing what T3 last reported
        </p>
      ))}
      {machines && <p className="text-xs text-muted-fg">{directory.pagination.total} matching projects, {directory.pagination.start}-{directory.pagination.end} shown</p>}
      {machines && directory.pagination.total === 0 && <Empty>No branches or worktrees match these filters.</Empty>}
      {Object.entries(tidyStates).map(([key, state]) => (
        <p key={key} role={state.msg && !state.msg.ok ? "alert" : "status"} className={cn("text-xs", state.msg && !state.msg.ok ? "text-bad" : "text-muted-fg")}>
          {state.label}: {state.busy ? "Queuing tidy task..." : state.msg?.text} {state.msg?.ok && <a href="#queue" className="text-primary">Open queue</a>}
        </p>
      ))}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {directory.pagination.items.map(({ machine, lane, rows }) => (
          <Lane key={`${machine.id}:${lane.projectId}`} machineLabel={machine.label} lane={lane} rows={rows} filterKey={filterKey} busy={tidyStates[`${machine.id}:${lane.projectId}`]?.busy ?? false} onTidy={() => void askTidy(machine.id, machine.label, lane)} />
        ))}
      </div>
      <Pager page={directory.pagination} onPageChange={setPage} label="Work projects" />
    </div>
  );
}

function Lane({ machineLabel, lane, rows, filterKey, busy, onTidy }: { machineLabel: string; lane: WorkLane; rows: WorkRow[]; filterKey: string; busy: boolean; onTidy: () => void }) {
  const [paging, setPaging] = useState({ filterKey, page: 1 });
  const [size, setSize] = useState(5);
  const [collapsed, setCollapsed] = useState(false);
  const page = paginateCollection(rows, paging.filterKey === filterKey ? paging.page : 1, size);
  const currentPage = page.page;
  useEffect(() => {
    setPaging((previous) => previous.filterKey === filterKey && previous.page === currentPage ? previous : { filterKey, page: currentPage });
  }, [currentPage, filterKey]);
  const tidy = lane.rows.filter((r) => r.tidy).length;
  return (
    <Card className="grid gap-3">
      <div className="flex items-center gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={!collapsed} aria-label={`Toggle ${lane.title} branches`} onClick={() => setCollapsed(!collapsed)}>
          <span className="block truncate font-medium">{collapsed ? <ChevronRight className="inline size-4" aria-hidden /> : <ChevronDown className="inline size-4" aria-hidden />} {lane.title}</span>
          <span className="block truncate text-xs text-muted-fg">{machineLabel}</span>
        </button>
        <Badge>
          {rows.length} / {lane.rows.length} branches
        </Badge>
      </div>
      {!collapsed && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-muted-fg">{page.start}-{page.end} of {rows.length} matching branches</span>
            <Select className="w-auto" aria-label={`Branches per page in ${lane.title}`} value={size} onChange={(e) => { setSize(Number(e.target.value)); setPaging({ filterKey, page: 1 }); }}>
              {[5, 20, 50].map((n) => <option key={n} value={n}>{n} per page</option>)}
            </Select>
          </div>
          <ul className="grid gap-3">
            {page.items.map((r) => (
              <Branch key={r.key} r={r} />
            ))}
          </ul>
          <Pager page={page} onPageChange={(page) => setPaging({ filterKey, page })} label={`${lane.title} branches`} />
        </>
      )}
      {tidy > 0 && (
        <div className="grid gap-1">
          <Button size="sm" disabled={busy} onClick={onTidy}>
            Ask an agent to tidy all {tidy} {tidy === 1 ? "branch" : "branches"}
          </Button>
        </div>
      )}
    </Card>
  );
}

const AGENT_DOT = { working: "running", "needs-you": "needs_you", idle: "idle" } as const;

function Branch({ r }: { r: WorkRow }) {
  const facts = [
    r.ahead ? `${r.ahead} ahead` : null,
    r.behind ? `${r.behind} behind` : null,
    r.changedFiles ? `${r.changedFiles} uncommitted` : null,
    r.threadCount > 1 ? `${r.threadCount} threads` : null,
    ago(r.updatedAt),
  ].filter(Boolean);
  return (
    <li className="grid gap-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <StatusDot status={AGENT_DOT[r.agent]} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={r.worktreePath ?? r.branch}>
          {r.branch}
        </span>
        {r.pr && (
          <a href={r.pr.url} target="_blank" rel="noreferrer" className="shrink-0">
            <Badge className={cn(r.pr.state === "merged" && "text-ok", r.pr.state === "open" && "text-info")}>
              #{r.pr.number} {r.pr.isDraft && r.pr.state === "open" ? "draft" : (r.pr.state ?? "PR")}
            </Badge>
          </a>
        )}
        {r.tidy && <Badge className="shrink-0 text-warn">{r.tidy}</Badge>}
      </div>
      <Stepper stage={r.stage} />
      <p className="truncate text-xs text-muted-fg">
        {r.title} · {facts.join(" · ")}
      </p>
      {(r.blocked || r.note) && <p className="text-xs text-muted-fg">{r.note ?? r.blocked}</p>}
      <div className="flex gap-2">
        <LinkButton size="sm" href={r.appUrl}>
          Open in T3
        </LinkButton>
        {r.webUrl && (
          <LinkButton size="sm" variant="ghost" href={r.webUrl} target="_blank" rel="noreferrer">
            Web
          </LinkButton>
        )}
      </div>
    </li>
  );
}

function Stepper({ stage }: { stage: number }) {
  return (
    <div className="grid gap-1">
      <ol aria-label={`Stage: ${STAGES[stage]}`} className="flex gap-1">
        {STAGES.map((label, i) => (
          <li key={label} aria-current={i === stage ? "step" : undefined} className={cn("h-1 flex-1 rounded-full", i <= stage ? "bg-primary" : "bg-accent")} />
        ))}
      </ol>
      <span className="text-xs font-medium">{STAGES[stage]}</span>
    </div>
  );
}
