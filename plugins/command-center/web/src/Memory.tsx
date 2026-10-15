import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MemoryEntry, MemoryKind } from "../../server/memory.ts";
import type { MachineProjects } from "../../server/types.ts";
import { call } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Input, Section, Select, Textarea } from "./ui/fields.tsx";

const kinds: MemoryKind[] = ["progress", "decision", "todo", "handoff", "note"];
const PAGE = 25;

const message = (e: unknown) => (e instanceof Error ? e.message : "Action failed");
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

/** Entries grouped by local day, keeping the (already newest-first) order. */
function byDay(entries: MemoryEntry[]) {
  const days: { day: string; entries: MemoryEntry[] }[] = [];
  for (const e of entries) {
    const day = dayLabel(e.createdAt);
    const last = days.at(-1);
    if (last?.day === day) last.entries.push(e);
    else days.push({ day, entries: [e] });
  }
  return days;
}

/** Notes, todos, decisions and handoffs written by you and your agents. */
export function Memory() {
  const [projects, setProjects] = useState<MachineProjects["projects"]>([]);
  const [project, setProject] = useState("all"); // "all" | "none" | project id
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [todos, setTodos] = useState<MemoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ kind: MemoryKind; text: string } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    call("GET /api/projects").then((m) => setProjects(m.flatMap((x) => x.projects)), () => {});
  }, []);
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const scope = { projectId: project === "all" ? undefined : project === "none" ? null : project };
  const load = async (more?: MemoryEntry) => {
    const n = ++seq.current; // a slower, older response must not overwrite a newer filter
    try {
      const [page, open] = await Promise.all([
        call("POST /api/memory/list", {
          body: { ...scope, kind: kind === "all" ? undefined : kind, query: query || undefined, limit: PAGE, before: more?.id, beforeCreatedAt: more?.createdAt },
        }),
        more ? null : call("POST /api/memory/list", { body: { ...scope, kind: "todo", done: false, query: query || undefined, limit: 50 } }),
      ]);
      if (n !== seq.current) return;
      setEntries((prev) => (more && prev ? [...prev, ...page.entries] : page.entries));
      setMore(page.hasMore);
      if (open) setTodos(open.entries);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(message(e));
    }
  };
  useEffect(() => void load(), [project, kind, query]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (e: MemoryEntry) => act(() => call("POST /api/memory/:id/done", { params: { id: e.id }, body: { done: !e.done } }));
  const remove = (e: MemoryEntry) => confirm("Delete this entry?") && act(() => call("DELETE /api/memory/:id", { params: { id: e.id } }));
  const save = () =>
    draft &&
    act(async () => {
      await call("POST /api/memory", { body: { kind: draft.kind, text: draft.text, projectId: scope.projectId ?? null } });
      setDraft(null);
    });

  // Open todos have their own section; the timeline shows the rest.
  const showTodos = todos.length > 0 && (kind === "all" || kind === "todo");
  const timeline = showTodos ? (entries ?? []).filter((e) => e.kind !== "todo" || e.done) : (entries ?? []);
  const titles = new Map(projects.map((p) => [p.id, p.title]));
  const row = (e: MemoryEntry) => (
    <Card key={e.id} className="grid gap-1">
      <div className="flex items-center gap-2">
        {e.kind === "todo" && (
          <input type="checkbox" className="size-5" checked={e.done} disabled={busy} onChange={() => void toggle(e)} aria-label={`Done: ${e.text.slice(0, 40)}`} />
        )}
        <Badge>{e.kind}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-fg">
          {e.projectId ? (titles.get(e.projectId) ?? e.projectId) : "No project"}
          {e.source !== "user" && ` · ${e.source}`}
        </span>
        <span className="text-xs text-muted-fg">{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <Button variant="ghost" size="icon" aria-label="Delete entry" disabled={busy} onClick={() => void remove(e)}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <p className={cn("break-words whitespace-pre-wrap", e.kind === "todo" && e.done && "text-muted-fg line-through")}>{e.text}</p>
    </Card>
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Memory</h1>
        <Button size="sm" onClick={() => setDraft(draft ? null : { kind: "note", text: "" })}>
          <Plus className="size-4" /> Add
        </Button>
      </div>

      {draft && (
        <Card className="grid gap-2">
          <Select value={draft.kind} aria-label="Kind" onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })}>
            {kinds.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
          <Textarea value={draft.text} maxLength={20000} placeholder="What should be remembered?" onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <Button variant="primary" disabled={busy || !draft.text.trim()} onClick={() => void save()}>
            Save
          </Button>
        </Card>
      )}

      <div className="grid gap-2">
        <Input type="search" value={search} placeholder="Search memory" aria-label="Search memory" onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-2">
          <Select value={project} aria-label="Project" onChange={(e) => setProject(e.target.value)}>
            <option value="all">All projects</option>
            <option value="none">No project</option>
            {projects.map((p) => (
              <option key={`${p.machineId}:${p.id}`} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
          <Select value={kind} aria-label="Kind filter" onChange={(e) => setKind(e.target.value as MemoryKind | "all")}>
            <option value="all">All kinds</option>
            {kinds.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </Select>
        </div>
      </div>

      {error && <p className="text-bad">{error}</p>}

      {showTodos && (
        <Section title="Open todos" count={todos.length}>
          {todos.map(row)}
        </Section>
      )}

      {entries === null ? (
        <p className="text-muted-fg">Loading...</p>
      ) : timeline.length === 0 && !more ? (showTodos ? null : (
          <Empty>{query || kind !== "all" || project !== "all" ? "Nothing matches." : "No memory yet. Add a note, or let an agent call memory_save."}</Empty>)
      ) : (
        byDay(timeline).map(({ day, entries: list }) => (
          <Section key={day} title={day}>
            {list.map(row)}
          </Section>
        ))
      )}

      {more && entries && (
        <Button disabled={busy} onClick={() => void load(entries.at(-1))}>
          Older
        </Button>
      )}
    </div>
  );
}
