import type { Alert, ThreadItem } from "../../server/types.ts";
import { useLive } from "./api.ts";
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
  if (!view) return null;
  const open = openKey === null ? undefined : [...view.needsYou.flatMap((n) => (n.kind === "thread" ? [n.thread] : [])), ...view.running, ...view.done].find((t) => t.key === openKey);
  const sub = (t: ThreadItem) => view.machines.find((m) => m.id === t.machineId)?.label ?? "";

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold">Home</h1>

      <Section title="Needs you" count={view.needsYou.length}>
        {view.needsYou.length === 0 && <Empty>Nothing waiting on you.</Empty>}
        {view.needsYou.map((n) => {
          if (n.kind === "alert") return <AlertRow key={n.alert.key} alert={n.alert} />;
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
      </Section>

      <Section title="Running" count={view.running.length}>
        {view.running.length === 0 && <Empty>No agents running.</Empty>}
        {view.running.map((t) => (
          <Row
            key={t.key}
            dot={t.status}
            title={t.title}
            sub={t.waitingUntil ? `Waiting until ${at(t.waitingUntil)}` : sub(t)}
            age={ago(t.updatedAt)}
            onClick={() => setOpen(t)}
          />
        ))}
      </Section>

      <Section title="Done, last 24 h" count={view.done.length}>
        {view.done.length === 0 && <Empty>Nothing finished yet.</Empty>}
        {view.done.map((t) => (
          <Row
            key={t.key}
            dot={t.failed ? "failed" : "completed"}
            title={t.title}
            sub={t.preview ?? sub(t)}
            age={ago(t.updatedAt)}
            onClick={() => setOpen(t)}
          />
        ))}
      </Section>

      {open && <ThreadSheet item={open} view={view} onClose={() => location.replace("#home")} />}
    </div>
  );
}
