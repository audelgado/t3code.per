import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SECTION_STATUSES, selectSectionPage, type Section, type SectionFields, type SectionStatus } from "../../server/sections.ts";
import { call } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { Badge, Card, Empty, Field, Input, Select, Textarea } from "./ui/fields.tsx";

const label = (s: string) => s.replace("_", " ");
const tone: Record<SectionStatus, string> = { todo: "", in_progress: "text-info", review: "text-info", blocked: "text-bad", done: "text-ok" };

function Editor({ section, onSaved, onDeleted, onClose }: { section: Section; onSaved: (s: Section) => void; onDeleted: (id: string) => void; onClose: () => void }) {
  const [f, setF] = useState({
    name: section.name,
    status: section.status,
    tasksDone: String(section.tasksDone),
    tasksTotal: String(section.tasksTotal),
    dueDate: section.dueDate ?? "",
    trying: section.trying ?? "",
    blocker: section.blocker ?? "",
    missing: section.missing.join("\n"),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    const body: Partial<SectionFields> = {
      name: f.name,
      status: f.status,
      tasksDone: Number(f.tasksDone),
      tasksTotal: Number(f.tasksTotal),
      dueDate: f.dueDate || null,
      trying: f.trying.trim() || null,
      blocker: f.blocker.trim() || null,
      missing: f.missing.split("\n").map((l) => l.trim()).filter(Boolean),
    };
    try {
      onSaved(await call("PATCH /api/sections/:id", { params: { id: section.id }, body }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete "${section.name}"? Sections that wait on it stop waiting.`)) return;
    setBusy(true);
    setError(null);
    try {
      await call("DELETE /api/sections/:id", { params: { id: section.id } });
      onDeleted(section.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 grid gap-2 border-t border-border pt-2">
      <Field label="Name">
        <Input value={f.name} maxLength={80} onChange={set("name")} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Status">
          <Select value={f.status} onChange={set("status")}>
            {SECTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due">
          <Input type="date" value={f.dueDate} onChange={set("dueDate")} />
        </Field>
        <Field label="Tasks done">
          <Input inputMode="numeric" value={f.tasksDone} onChange={set("tasksDone")} />
        </Field>
        <Field label="Tasks total">
          <Input inputMode="numeric" value={f.tasksTotal} onChange={set("tasksTotal")} />
        </Field>
      </div>
      <Field label="Trying">
        <Input value={f.trying} maxLength={500} onChange={set("trying")} />
      </Field>
      <Field label="Blocker">
        <Input value={f.blocker} maxLength={500} onChange={set("blocker")} />
      </Field>
      <Field label="Missing (one per line)">
        <Textarea className="min-h-16" value={f.missing} onChange={set("missing")} />
      </Field>
      {error && (
        <p role="alert" className="text-bad">
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !f.name.trim()} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <Button variant="danger" disabled={busy} onClick={() => void remove()}>
        Delete section
      </Button>
    </div>
  );
}

function SectionCard({ s, names, editing, onEdit, onSaved, onDeleted }: { s: Section; names: Map<string, string>; editing: boolean; onEdit: (id: string | null) => void; onSaved: (s: Section) => void; onDeleted: (id: string) => void }) {
  return (
    <Card>
      <button type="button" className="grid w-full gap-1 text-left" aria-expanded={editing} onClick={() => onEdit(editing ? null : s.id)}>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
          <Badge className={tone[s.status]}>{label(s.status)}</Badge>
        </span>
        <span className="text-muted-fg">
          {s.tasksDone}/{s.tasksTotal} tasks{s.dueDate && ` · due ${s.dueDate}`}
        </span>
        {s.trying && <span className="break-words">Trying: {s.trying}</span>}
        {s.blocker && <span className="break-words text-bad">Blocked: {s.blocker}</span>}
        {s.missing.length > 0 && <span className="break-words text-muted-fg">Missing: {s.missing.join(", ")}</span>}
        {s.dependsOn.length > 0 && <span className="text-muted-fg">Waits on {s.dependsOn.map((id) => names.get(id) ?? "a removed section").join(", ")}</span>}
      </button>
      {s.prUrl && (
        <a href={s.prUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate text-primary">
          Pull request
        </a>
      )}
      {editing && <Editor section={s} onSaved={onSaved} onDeleted={onDeleted} onClose={() => onEdit(null)} />}
    </Card>
  );
}

function ProjectGroup({ projectId, title, sections, names, search, status, onChanged, onDeleted }: {
  projectId: string;
  title: string;
  sections: Section[];
  names: Map<string, string>;
  search: string;
  status: SectionStatus | "all";
  onChanged: (s: Section) => void;
  onDeleted: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const p = selectSectionPage({ sections, search, status, page, editing });

  async function add() {
    setError(null);
    try {
      onChanged(await call("POST /api/sections", { body: { projectId, name } }));
      setName("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add");
    }
  }

  return (
    <section className="grid gap-2">
      <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-fg uppercase">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="font-normal normal-case">{p.total}</span>
        <Button variant="ghost" size="icon" aria-label={`Add a section to ${title}`} onClick={() => setAdding((v) => !v)}>
          <Plus className="size-4" />
        </Button>
      </h2>
      {adding && (
        <Card className="grid gap-2">
          <Input placeholder="Section name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          {error && (
            <p role="alert" className="text-bad">
              {error}
            </p>
          )}
          <Button variant="primary" disabled={!name.trim()} onClick={() => void add()}>
            Add section
          </Button>
        </Card>
      )}
      {p.visible.map((s) => (
        <SectionCard key={s.id} s={s} names={names} editing={editing === s.id} onEdit={setEditing} onSaved={onChanged} onDeleted={onDeleted} />
      ))}
      {p.total === 0 && !adding && <Empty>{sections.length ? "No sections match." : "No sections yet."}</Empty>}
      {p.pageCount > 1 && (
        <div className="flex items-center justify-between text-muted-fg">
          <Button variant="ghost" size="icon" aria-label="Previous page" disabled={p.page <= 1} onClick={() => setPage(p.page - 1)}>
            <ChevronLeft className="size-4" />
          </Button>
          <span className="tabular-nums">
            {p.start}-{p.end} of {p.total}
          </span>
          <Button variant="ghost" size="icon" aria-label="Next page" disabled={p.page >= p.pageCount} onClick={() => setPage(p.page + 1)}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </section>
  );
}

/** Sections grouped by project, 10 per page. Route: `#sections`. */
export function Sections() {
  const [sections, setSections] = useState<Section[] | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SectionStatus | "all">("all");

  useEffect(() => {
    Promise.all([call("GET /api/sections"), call("GET /api/projects")]).then(
      ([s, groups]) => {
        setSections(s);
        setTitles(new Map(groups.flatMap((g) => g.projects.map((p) => [p.id, p.title] as const))));
      },
      (e) => setError(e instanceof Error ? e.message : "Could not load sections"),
    );
  }, []);

  const changed = useCallback((s: Section) => setSections((all) => (all?.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? s : x)) : [...(all ?? []), s])), []);
  const deleted = useCallback((id: string) => setSections((all) => (all ?? []).filter((x) => x.id !== id).map((x) => (x.dependsOn.includes(id) ? { ...x, dependsOn: x.dependsOn.filter((d) => d !== id) } : x))), []);
  const names = useMemo(() => new Map((sections ?? []).map((s) => [s.id, s.name])), [sections]);
  // Every known project shows (so it can get its first section), plus any with sections of its own.
  const projectIds = [...new Set([...titles.keys(), ...(sections ?? []).map((s) => s.projectId)])];

  if (error) return <p role="alert" className="text-bad">{error}</p>;
  if (!sections) return null;
  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold">Sections</h1>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Input type="search" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select className="w-auto" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as SectionStatus | "all")}>
          <option value="all">All</option>
          {SECTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {label(s)}
            </option>
          ))}
        </Select>
      </div>
      {projectIds.length === 0 && <Empty>No projects yet.</Empty>}
      {projectIds.map((id) => (
        <ProjectGroup
          key={id}
          projectId={id}
          title={titles.get(id) ?? "Unknown project"}
          sections={sections.filter((s) => s.projectId === id)}
          names={names}
          search={search}
          status={status}
          onChanged={changed}
          onDeleted={deleted}
        />
      ))}
    </div>
  );
}
