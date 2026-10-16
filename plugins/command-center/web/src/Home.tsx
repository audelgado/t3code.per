import { useEffect, useState } from "react";
import type { Alert, ThreadItem } from "../../server/types.ts";
import { useLive } from "./api.ts";
import { homeAttention, homeThread } from "./homeQueueView.ts";
import { paginateCollection } from "./pagination.ts";
import { Pager } from "./ui/Pager.tsx";
import { LinkButton } from "./ui/Button.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { ThreadSheet } from "./ThreadSheet.tsx";
import { ago, at } from "./ui/cn.ts";
import { Card, Empty, Section } from "./ui/fields.tsx";

const reasonLabel = { approval: "Approval needed", input: "Input needed", plan: "Plan ready" } as const;

function Row({ onClick, dot, title, sub, age }: { onClick: () => void; dot: ThreadItem["status"]; title: string; sub: string; age: string }) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <Card className="flex items-center gap-3 active:bg-accent">
        <StatusDot status={dot} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{title}</span>
          <span className="block truncate text-muted-fg">{sub}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-fg">{age}</span>
      </Card>
    </button>
  );
}

function AlertRow({ alert }: { alert: Alert }) {
  return (
    <Card className="flex items-start gap-3 border-warn/40">
      <StatusDot status="waiting" className="mt-1.5" />
      <span className="min-w-0 flex-1">{alert.message}</span>
      <span className="shrink-0 text-xs text-muted-fg">{ago(alert.since)}</span>
    </Card>
  );
}

/** Opens a thread's sheet through the hash, so push links and the back button work. */
const setOpen = (t: ThreadItem) => (location.hash = `#item=${encodeURIComponent(t.key)}`);

/** `openKey`: a ThreadItem.key from `#item=<key>`; its sheet follows the live view. */
export function Home({ openKey }: { openKey: string | null }) {
  const { view } = useLive();
  const [needsPage, setNeedsPage] = useState(1);
  const [runningPage, setRunningPage] = useState(1);
  const [donePage, setDonePage] = useState(1);
  const attention = homeAttention(view?.needsYou ?? []);
  const needs = paginateCollection(attention.actions, needsPage, 5);
  const running = paginateCollection(view?.running ?? [], runningPage, 5);
  const done = paginateCollection(view?.done ?? [], donePage, 5);
  useEffect(() => {
    if (!view) return;
    setNeedsPage(needs.page); setRunningPage(running.page); setDonePage(done.page);
  }, [view, needs.page, running.page, done.page]);
  if (!view) return null;
  const open = homeThread(view, openKey);
  const sub = (t: ThreadItem) => view.machines.find((m) => m.id === t.machineId)?.label ?? "";

  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
      <div className="grid gap-3 lg:col-span-2">
        <h1 className="text-xl font-semibold">Home</h1>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[["Needs you", view.needsYou.length], ["Running", view.running.length], ["Done in 24 h", view.done.length], ["Queued", view.queue.filter((t) => t.status === "queued").length]].map(([label, count]) => (
            <Card key={label}>
              <dt className="text-xs text-muted-fg">{label}</dt>
              <dd className="text-2xl font-semibold tabular-nums">{count}</dd>
            </Card>
          ))}
        </dl>
        <nav aria-label="Quick links" className="flex flex-wrap gap-2">
          <LinkButton size="sm" variant="primary" href="#ask">Ask</LinkButton>
          <LinkButton size="sm" href="#projects">Projects</LinkButton>
          <LinkButton size="sm" href="#work">Work</LinkButton>
        </nav>
        {(view.running.length >= 50 || view.done.length >= 30) && <p className="text-xs text-muted-fg">Showing up to 50 running threads and the 30 most recent completions in the last 24 hours.</p>}
      </div>

      <div className="min-w-0 lg:col-span-2">
        <Section title="Needs you" count={view.needsYou.length}>
          {view.needsYou.length === 0 && <Empty>Nothing waiting on you.</Empty>}
          {attention.alerts.map((n) => <AlertRow key={n.alert.key} alert={n.alert} />)}
          {attention.alerts.length > 0 && attention.actions.length > 0 && <p className="text-xs text-muted-fg">{attention.alerts.length} alerts always shown · {attention.actions.length} actions below</p>}
          {needs.items.map((n) => {
            if (n.kind === "workflow")
              return (
                <Row
                  key={n.key}
                  dot="waiting"
                  title={n.title}
                  sub={`Workflow · ${n.text}`}
                  age={ago(n.since)}
                  onClick={() => (location.hash = `#workflows?run=${encodeURIComponent(n.runId)}`)}
                />
              );
            if (n.kind === "task_approval")
              return (
                <Row
                  key={n.task.id}
                  dot="waiting"
                  title={n.task.title}
                  sub={`Approve task · ${n.task.machineLabel}`}
                  age={ago(n.since)}
                  onClick={() => (location.hash = "#queue")}
                />
              );
            return (
              <Row
                key={n.thread.key}
                dot="waiting"
                title={n.thread.title}
                sub={`${reasonLabel[n.reason]} · ${sub(n.thread)}`}
                age={ago(n.since)}
                onClick={() => setOpen(n.thread)}
              />
            );
          })}
          <Pager page={needs} onPageChange={setNeedsPage} label="Needs you" />
        </Section>
      </div>

      <div className="min-w-0">
        <Section title="Running" count={view.running.length}>
          {view.running.length === 0 && <Empty>No agents running.</Empty>}
          {running.items.map((t) => (
            <Row
              key={t.key}
              dot={t.status}
              title={t.title}
              sub={t.waitingUntil ? `Waiting until ${at(t.waitingUntil)}` : sub(t)}
              age={ago(t.updatedAt)}
              onClick={() => setOpen(t)}
            />
          ))}
          <Pager page={running} onPageChange={setRunningPage} label="Running" />
        </Section>
      </div>

      <div className="min-w-0">
        <Section title="Done, last 24 h" count={view.done.length}>
          {view.done.length === 0 && <Empty>Nothing finished yet.</Empty>}
          {done.items.map((t) => (
            <Row
              key={t.key}
              dot={t.failed ? "failed" : "completed"}
              title={t.title}
              sub={t.preview ?? sub(t)}
              age={ago(t.updatedAt)}
              onClick={() => setOpen(t)}
            />
          ))}
          <Pager page={done} onPageChange={setDonePage} label="Done" />
        </Section>
      </div>

      {open && <ThreadSheet item={open} view={view} onClose={() => location.replace("#home")} />}
    </div>
  );
}
