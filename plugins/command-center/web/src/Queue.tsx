import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import type { RuntimeMode, TaskItem } from "../../server/types.ts";
import { call, refresh, useLive } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button } from "./ui/Button.tsx";
import { at } from "./ui/cn.ts";
import { Badge, Card, Empty, Select } from "./ui/fields.tsx";

const modes: [RuntimeMode, string][] = [
  ["approval-required", "Ask before every action"],
  ["auto-accept-edits", "Auto-accept edits"],
  ["auto", "Auto"],
  ["full-access", "Full access"],
];

const cancellable = new Set(["pending_approval", "queued", "starting", "running", "waiting", "needs_you"]);

function TaskCard({ t, titles }: { t: TaskItem; titles: Map<string, string> }) {
  const [mode, setMode] = useState<RuntimeMode>("auto-accept-edits");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
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
            <Select value={mode} onChange={(e) => setMode(e.target.value as RuntimeMode)}>
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
  if (!view) return null;
  const titles = new Map(view.queue.map((t) => [t.id, t.title]));
  return (
    <div className="grid gap-3">
      <h1 className="text-xl font-semibold">Queue</h1>
      {view.queue.length === 0 && <Empty>The queue is empty.</Empty>}
      {view.queue.map((t) => (
        <TaskCard key={t.id} t={t} titles={titles} />
      ))}
    </div>
  );
}
