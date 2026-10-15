import { useEffect, useState } from "react";
import type { WorkApi, WorkLane, WorkMachine, WorkRow } from "../../server/work.ts";
import { call, refresh } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Section } from "./ui/fields.tsx";

// ponytail: typed through this cast until the routes are merged into Api (server/types.ts).
const api = call as unknown as <R extends keyof WorkApi>(route: R, opts?: { body?: WorkApi[R]["body"] }) => Promise<WorkApi[R]["res"]>;

/** Mirrors STAGES in server/work.ts (a value import would pull server code into the bundle). */
const STAGES = ["Created", "Working", "Committed", "Pushed", "PR open", "Merged", "Cleanup"];

/** Matches the server's cache window, so a poll never finds a fresh read pending. */
const POLL_MS = 30_000;

/** Branches and PRs per project, grouped by machine. Reads only while mounted and the page is visible. */
export function Work() {
  const [machines, setMachines] = useState<WorkMachine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Work</h1>
      {error && <p className="text-bad">{error}</p>}
      {machines === null && !error && <p className="text-muted-fg">Loading...</p>}
      {machines?.length === 0 && <Empty>No branches or worktrees yet.</Empty>}
      {machines?.map((m) => (
        <Section key={m.id} title={m.label}>
          {m.status !== "online" && (
            <p className="flex items-center gap-2 text-muted-fg">
              <StatusDot status={m.status} /> {m.status}: showing what T3 last reported
            </p>
          )}
          {m.lanes.map((lane) => (
            <Lane key={lane.projectId} machineId={m.id} lane={lane} />
          ))}
        </Section>
      ))}
    </div>
  );
}

function Lane({ machineId, lane }: { machineId: string; lane: WorkLane }) {
  const tidy = lane.rows.filter((r) => r.tidy).length;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function askTidy() {
    setBusy(true);
    setMsg(null);
    try {
      await api("POST /api/work/tidy", { body: { machineId, projectId: lane.projectId } });
      refresh();
      setMsg({ ok: true, text: "Tidy task queued." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="grid gap-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{lane.title}</span>
        <Badge>
          {lane.rows.length} {lane.rows.length === 1 ? "branch" : "branches"}
        </Badge>
      </div>
      <ul className="grid gap-3">
        {lane.rows.map((r) => (
          <Branch key={r.key} r={r} />
        ))}
      </ul>
      {tidy > 0 && (
        <div className="grid gap-1">
          <Button size="sm" disabled={busy} onClick={askTidy}>
            Ask an agent to tidy {tidy} {tidy === 1 ? "branch" : "branches"}
          </Button>
          {msg && (
            <p role={msg.ok ? undefined : "alert"} className={cn("text-xs", msg.ok ? "text-muted-fg" : "text-bad")}>
              {msg.text} {msg.ok && <a href="#queue" className="text-primary">Open queue</a>}
            </p>
          )}
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
