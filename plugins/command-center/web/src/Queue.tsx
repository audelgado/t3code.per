import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import type { RuntimeMode, TaskItem } from "../../server/types.ts";
import { call, refresh, useLive } from "./api.ts";
import { queueGroup, queueGroups, queueResults } from "./homeQueueView.ts";
import { paginateCollection } from "./pagination.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Pager } from "./ui/Pager.tsx";
import { Button } from "./ui/Button.tsx";
import { at } from "./ui/cn.ts";
import { Badge, Card, Empty, Field, Input, Select } from "./ui/fields.tsx";

const modes: [RuntimeMode, string][] = [
  ["approval-required", "Ask before every action"],
  ["auto-accept-edits", "Auto-accept edits"],
  ["auto", "Auto"],
  ["full-access", "Full access"],
];

const cancellable = new Set(["pending_approval", "queued", "starting", "running", "waiting", "needs_you"]);

type TaskCardState = { mode: RuntimeMode; error: string | null; busy: boolean };
const initialTaskState: TaskCardState = { mode: "auto-accept-edits", error: null, busy: false };

function TaskCard({ t, titles, state, update }: { t: TaskItem; titles: Map<string, string>; state: TaskCardState; update: (patch: Partial<TaskCardState>) => void }) {
  const { mode, error, busy } = state;

  const act = async (fn: () => Promise<unknown>) => {
    update({ busy: true, error: null });
    try {
      await fn();
      await refresh();
    } catch (e) {
      update({ error: e instanceof Error ? e.message : "Action failed" });
    } finally {
      update({ busy: false });
    }
  };
  const params = { id: t.id };
  const approval = t.status === "pending_approval";
  const bump = (d: number) => act(() => call("PATCH /api/tasks/:id", { params, body: { priority: Math.max(-2, Math.min(2, t.priority + d)) } }));

  return (
    <Card className="grid gap-2">
      <div className="flex items-center gap-2">
        <StatusDot status={t.status} />
        <span className="min-w-0 flex-1 truncate font-medium">{t.title}</span>
        <Badge>{t.status.replace("_", " ")}</Badge>
      </div>
      <p className="text-muted-fg">
        {t.machineLabel} · {t.projectTitle}
        {t.source !== "user" && ` · from ${t.source.slice(6)}`}
        {t.priority !== 0 && ` · priority ${t.priority > 0 ? "+" : ""}${t.priority}`}
      </p>
      {/* An agent-submitted prompt is shown in full: approving it launches an agent with this text. */}
      {approval ? (
        <p className="max-h-72 overflow-y-auto rounded-lg bg-accent p-2 break-words whitespace-pre-wrap">{t.prompt}</p>
      ) : (
        <p className="line-clamp-3 break-words whitespace-pre-wrap text-muted-fg">{t.prompt}</p>
      )}
      {t.status === "waiting" && t.limitResetAt && <p className="text-warn">Waiting on a usage limit until {at(t.limitResetAt)}</p>}
      {t.blockedBy.length > 0 && (
        <p className="text-muted-fg">Blocked by {t.blockedBy.map((id) => titles.get(id) ?? id).join(", ")}</p>
      )}
      {t.error && <p className="text-bad">{t.error}</p>}
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}

      {approval && (
        <>
          <label className="grid gap-1">
            <span className="text-xs font-medium text-muted-fg">Runtime mode</span>
            <Select value={mode} onChange={(e) => update({ mode: e.target.value as RuntimeMode })}>
              {modes.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="danger" disabled={busy} onClick={() => void act(() => call("POST /api/tasks/:id/reject", { params }))}>
              Reject
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void act(() => call("POST /api/tasks/:id/approve", { params, body: { runtimeMode: mode } }))}>
              Approve
            </Button>
          </div>
        </>
      )}

      {!approval && (
        <div className="flex items-center gap-2">
          {t.status === "queued" && (
            <>
              <Button variant="ghost" size="icon" aria-label="Raise priority" disabled={busy || t.priority >= 2} onClick={() => void bump(1)}>
                <ArrowUp className="size-4" />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Lower priority" disabled={busy || t.priority <= -2} onClick={() => void bump(-1)}>
                <ArrowDown className="size-4" />
              </Button>
            </>
          )}
          <span className="flex-1" />
          {(t.status === "failed" || t.status === "cancelled") && (
            <Button size="sm" disabled={busy} onClick={() => void act(() => call("POST /api/tasks/:id/retry", { params }))}>
              Retry
            </Button>
          )}
          {cancellable.has(t.status) && (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => void act(() => call("POST /api/tasks/:id/cancel", { params }))}>
              Cancel
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export function Queue() {
  const { view } = useLive();
  const [query, setQuery] = useState("");
  const [machine, setMachine] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(5);
  // Paging/filtering must not discard a pending action, its error, or approval permissions.
  const [cardStates, setCardStates] = useState<Record<string, TaskCardState>>({});
  const results = queueResults(view?.queue ?? [], query, machine, status);
  const visible = paginateCollection(results, page, size);
  useEffect(() => { if (view) setPage(visible.page); }, [view, visible.page]);
  useEffect(() => {
    if (!view) return;
    const ids = new Set(view.queue.map((t) => t.id));
    setCardStates((current) => {
      const entries = Object.entries(current).filter(([id, state]) => ids.has(id) || state.busy);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [view]);
  if (!view) return null;
  const titles = new Map(view.queue.map((t) => [t.id, t.title]));
  const machines = new Map([...view.machines.map((m) => [m.id, m.label] as const), ...view.queue.map((t) => [t.machineId, t.machineLabel] as const)]);
  return (
    <div className="grid gap-3">
      <h1 className="text-xl font-semibold">Queue</h1>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Search tasks"><Input type="search" value={query} placeholder="Title, prompt, project…" onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></Field>
        <Field label="Machine"><Select value={machine} onChange={(e) => { setMachine(e.target.value); setPage(1); }}>
          <option value="">All machines</option>
          {[...machines].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select></Field>
        <Field label="Status"><Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          {["pending_approval", "starting", "running", "waiting", "needs_you", "queued", "failed", "cancelled", "done"].map((s) => <option key={s} value={s}>{s.replaceAll("_", " ")}</option>)}
        </Select></Field>
        <Field label="Tasks per page"><Select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>
          {[5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
        </Select></Field>
      </div>
      <p role="status" className="text-xs text-muted-fg">{results.length} of {view.queue.length} loaded tasks match. Showing {visible.start}–{visible.end}.</p>
      {(query || machine || status) && <div><Button size="sm" variant="ghost" onClick={() => { setQuery(""); setMachine(""); setStatus(""); setPage(1); }}>Clear filters</Button></div>}
      {view.queue.length === 0 && <Empty>The queue is empty.</Empty>}
      {view.queue.length > 0 && results.length === 0 && <Empty>No tasks match these filters.</Empty>}
      {queueGroups.map((group) => {
        const items = visible.items.filter((t) => queueGroup(t.status) === group);
        if (!items.length) return null;
        return <section key={group} className="grid gap-2">
          <h2 className="text-xs font-semibold text-muted-fg">{group} · {results.filter((t) => queueGroup(t.status) === group).length}</h2>
          <div className="grid items-start gap-3 xl:grid-cols-2">
            {items.map((t) => <TaskCard key={t.id} t={t} titles={titles} state={cardStates[t.id] ?? initialTaskState} update={(patch) => setCardStates((states) => ({ ...states, [t.id]: { ...(states[t.id] ?? initialTaskState), ...patch } }))} />)}
          </div>
        </section>;
      })}
      <Pager page={visible} onPageChange={setPage} label="Tasks" />
    </div>
  );
}
