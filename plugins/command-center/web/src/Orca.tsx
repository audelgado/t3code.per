import { useEffect, useState, type FormEvent } from "react";
import type { OrcaApi, OrcaList, OrcaTerminal, OrcaWorktree } from "../../server/orca.ts";
import { call } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button } from "./ui/Button.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Field, Input, Section, Select, Textarea } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

// ponytail: typed through this cast until the routes are merged into Api (server/types.ts).
const api = call as unknown as <R extends keyof OrcaApi>(
  route: R,
  opts?: { params?: Record<string, string>; body?: OrcaApi[R]["body"] },
) => Promise<OrcaApi[R]["res"]>;

/** Each list runs three Orca CLI calls on its machine; keep it gentle. */
const POLL_MS = 15_000;
const message = (e: unknown) => (e instanceof Error ? e.message : "Failed");

const age = (ms: number | null) => ago(ms ? new Date(ms).toISOString() : null);

/** Orca worktrees and terminals on one machine: read screens, send input, launch an agent. Reads only while visible. */
export function Orca() {
  const [list, setList] = useState<OrcaList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<{ worktree: OrcaWorktree; terminal: OrcaTerminal } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    let live = true;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      clearTimeout(timer);
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      api("GET /api/orca")
        .then(
          (l) => {
            if (!live) return;
            setList(l);
            setError(null);
          },
          (e: unknown) => live && setError(message(e)),
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
  }, [tick]);

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Orca</h1>
        {list?.configured && (
          <Badge className={list.running ? "text-ok" : "text-warn"}>{list.running ? `running${list.version ? ` ${list.version}` : ""}` : "not running"}</Badge>
        )}
        <Button size="sm" variant="ghost" onClick={reload}>
          Refresh
        </Button>
      </div>
      {error && <p className="text-bad">{error}</p>}
      {list === null && !error && <p className="text-muted-fg">Loading...</p>}
      {list && !list.configured && <Empty>Orca is off. Set CC_ORCA_CLI on the Command Center server to use it.</Empty>}
      {list?.configured && list.message && <p className="text-warn">{list.message}</p>}

      {list?.running && (
        <>
          <Section title="Worktrees" count={list.worktrees.length}>
            {list.worktrees.length === 0 && <Empty>No live Orca terminals.</Empty>}
            {list.worktrees.map((w) => (
              <WorktreeCard key={w.id} w={w} onOpen={(terminal) => setOpen({ worktree: w, terminal })} />
            ))}
          </Section>
          <LaunchForm repos={list.repos} onLaunched={reload} />
        </>
      )}

      {open && <TerminalSheet {...open} onClose={() => setOpen(null)} onStale={reload} />}
    </div>
  );
}

function WorktreeCard({ w, onOpen }: { w: OrcaWorktree; onOpen: (t: OrcaTerminal) => void }) {
  return (
    <Card className="grid gap-2">
      <div className="flex items-center gap-2">
        <StatusDot status={w.status === "working" ? "running" : "idle"} />
        <span className="min-w-0 flex-1 truncate font-medium" title={w.path}>
          {w.name}
        </span>
        {w.unread && <Badge className="text-info">unread</Badge>}
        {w.hostId && w.hostId !== "local" && <Badge>{w.hostId.split(":")[0]}</Badge>}
      </div>
      {w.branch && <p className="truncate font-mono text-xs text-muted-fg">{w.branch}</p>}
      <ul className="grid gap-1">
        {w.terminals.map((t) => (
          <li key={t.handle}>
            <button type="button" onClick={() => onOpen(t)} className="grid w-full gap-0.5 rounded-lg p-2 text-left active:bg-accent">
              <span className="flex items-center gap-2">
                <Badge className="shrink-0">{t.agent ?? "shell"}</Badge>
                <span className="min-w-0 flex-1 truncate text-sm">{t.title}</span>
                <span className="shrink-0 text-xs text-muted-fg">{age(t.lastOutputAt)}</span>
              </span>
              {t.preview && <span className="truncate font-mono text-xs text-muted-fg">{t.preview}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TerminalSheet({ worktree, terminal, onClose, onStale }: { worktree: OrcaWorktree; terminal: OrcaTerminal; onClose: () => void; onStale: () => void }) {
  const params = { handle: terminal.handle };
  const [screen, setScreen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const fail = (e: unknown) => {
    const m = message(e);
    setNote({ ok: false, text: m });
    if (/re-list/.test(m)) onStale();
  };
  const read = () =>
    api("GET /api/orca/:handle", { params }).then((r) => setScreen(r.text || "(empty screen)"), fail);

  useEffect(() => {
    void read();
  }, [terminal.handle]);

  async function send(body: { text?: string; interrupt?: boolean }) {
    setBusy(true);
    setNote(null);
    try {
      const r = await api("POST /api/orca/:handle/send", { params, body });
      if (body.text) setText("");
      setNote({ ok: true, text: r.accepted === false ? "Orca did not accept the input." : "Sent. Read the screen to see the reply." });
      setTimeout(read, 2_000); // one read once the agent had a moment; never a resend
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) void send({ text });
  };

  return (
    <Sheet title={terminal.title} onClose={onClose}>
      <div className="grid gap-3">
        <p className="text-muted-fg">
          {worktree.name} · {terminal.agent ?? "shell"}
          {terminal.connected ? "" : " · disconnected"}
        </p>
        <pre className="max-h-[45dvh] overflow-auto rounded-lg border border-border bg-card p-2 font-mono text-[11px] leading-snug whitespace-pre">
          {screen ?? "Reading..."}
        </pre>
        {note && (
          <p role={note.ok ? undefined : "alert"} className={cn("text-xs", note.ok ? "text-muted-fg" : "text-bad")}>
            {note.text}
          </p>
        )}
        {terminal.writable ? (
          <form onSubmit={submit} className="grid gap-2">
            <Textarea className="min-h-20" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type to the agent; Enter is added" maxLength={16_000} />
            <div className="grid grid-cols-3 gap-2">
              <Button type="button" disabled={busy} onClick={() => void read()}>
                Read
              </Button>
              <Button type="button" variant="danger" disabled={busy} onClick={() => void send({ interrupt: true })}>
                Interrupt
              </Button>
              <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
                Send
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-2">
            <p className="text-muted-fg">This terminal is read-only.</p>
            <Button disabled={busy} onClick={() => void read()}>
              Read
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function LaunchForm({ repos, onLaunched }: { repos: OrcaList["repos"]; onLaunched: () => void }) {
  const [projectPath, setProjectPath] = useState(repos[0]?.path ?? "");
  const [agent, setAgent] = useState<"codex" | "claude">("codex");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      await api("POST /api/orca/launch", { body: { projectPath, agent, name, prompt } });
      setPrompt("");
      setName("");
      setNote({ ok: true, text: "Launched in a new Orca worktree." });
      onLaunched();
    } catch (e) {
      setNote({ ok: false, text: message(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Launch in Orca">
      <Card>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Repo path">
            <Input list="orca-repos" value={projectPath} onChange={(e) => setProjectPath(e.target.value)} required />
            <datalist id="orca-repos">
              {repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </datalist>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Agent">
              <Select value={agent} onChange={(e) => setAgent(e.target.value as "codex" | "claude")}>
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </Select>
            </Field>
            <Field label="Worktree name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="fix-login" pattern="[A-Za-z0-9][A-Za-z0-9._\-]{0,63}" required />
            </Field>
          </div>
          <Field label="Prompt">
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={16_000} required />
          </Field>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Launching..." : "Launch"}
          </Button>
          {note && (
            <p role={note.ok ? undefined : "alert"} className={cn("text-xs", note.ok ? "text-muted-fg" : "text-bad")}>
              {note.text}
            </p>
          )}
        </form>
      </Card>
    </Section>
  );
}
