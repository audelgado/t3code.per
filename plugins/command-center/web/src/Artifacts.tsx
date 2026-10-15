import { Archive, ArchiveRestore, GitCompare, Plus, RotateCcw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, ArtifactDetail, DiffLine } from "../../server/artifacts.ts";
import type { MachineProjects } from "../../server/types.ts";
import { call } from "./api.ts";
import { Button } from "./ui/Button.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Input, Section, Select, Textarea } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

const PAGE = 30;
/** Mirrors ARTIFACT_MAX_BYTES in server/artifacts.ts (a value import would pull server code into the bundle). */
const MAX_BYTES = 64 * 1024;

const message = (e: unknown) => (e instanceof Error ? e.message : "Action failed");

// Loaded on first Markdown view only, so the rest of the app never pays for the parser.
const Markdown = lazy(async () => {
  const [{ default: Md }, { default: gfm }] = await Promise.all([import("react-markdown"), import("remark-gfm")]);
  return {
    default: ({ text }: { text: string }) => (
      <Md
        remarkPlugins={[gfm]}
        components={{
          a: (p) => <a {...p} target="_blank" rel="noopener noreferrer" />,
          // Images become links: a remote <img> would load from a third-party host as soon as the page opens.
          img: ({ src, alt }) => (
            <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer">
              {alt || (typeof src === "string" ? src : "image")}
            </a>
          ),
        }}
      >
        {text}
      </Md>
    ),
  };
});

/** HTML and Markdown pages saved by you and your agents, with every version kept. */
export function Artifacts() {
  const [projects, setProjects] = useState<MachineProjects["projects"]>([]);
  const [project, setProject] = useState("all"); // "all" | "none" | project id
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<Artifact[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ title: string; content: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);
  const close = useCallback(() => setOpen(null), []); // stable, so the sheet keeps its focus across reloads

  useEffect(() => {
    call("GET /api/projects").then((m) => setProjects(m.flatMap((x) => x.projects)), () => {});
  }, []);
  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const projectId = project === "all" ? undefined : project === "none" ? null : project;
  const load = async (after?: Artifact) => {
    const n = ++seq.current; // a slower, older response must not overwrite a newer filter
    try {
      const page = await call("POST /api/artifacts/list", {
        body: { projectId, archived, query: query || undefined, limit: PAGE, before: after?.id, beforeUpdatedAt: after?.updatedAt },
      });
      if (n !== seq.current) return;
      setRows((prev) => (after && prev ? [...prev, ...page.artifacts] : page.artifacts));
      setMore(page.hasMore);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(message(e));
    }
  };
  useEffect(() => void load(), [project, archived, query]);

  const tooBig = draft !== null && new TextEncoder().encode(draft.content).length > MAX_BYTES;
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await call("POST /api/artifacts", { body: { title: draft.title, content: draft.content, projectId: projectId ?? null } });
      setDraft(null);
      await load();
      setOpen(saved.artifact.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const titles = new Map(projects.map((p) => [p.id, p.title]));
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Artifacts</h1>
        <Button size="sm" onClick={() => setDraft(draft ? null : { title: "", content: "" })}>
          <Plus className="size-4" /> Add
        </Button>
      </div>

      {draft && (
        <Card className="grid gap-2">
          <Input value={draft.title} maxLength={200} placeholder="Title" aria-label="Title" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <Textarea
            value={draft.content}
            className="min-h-40 font-mono text-sm"
            placeholder="Paste HTML or Markdown"
            aria-label="Content"
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          {tooBig && <p className="text-sm text-bad">Too large: an artifact version holds at most 64 KB.</p>}
          <Button variant="primary" disabled={busy || tooBig || !draft.title.trim() || !draft.content.trim()} onClick={() => void save()}>
            Save
          </Button>
        </Card>
      )}

      <div className="grid gap-2">
        <Input type="search" value={search} placeholder="Search titles" aria-label="Search artifacts" onChange={(e) => setSearch(e.target.value)} />
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
          <Select value={archived ? "archived" : "active"} aria-label="Show" onChange={(e) => setArchived(e.target.value === "archived")}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
        </div>
      </div>

      {error && <p className="text-bad">{error}</p>}

      {rows === null ? (
        <p className="text-muted-fg">Loading...</p>
      ) : rows.length === 0 ? (
        <Empty>{query || archived || project !== "all" ? "Nothing matches." : "No artifacts yet. Add one, or let an agent call artifact_save."}</Empty>
      ) : (
        <Section title={archived ? "Archived" : "Recent"} count={rows.length}>
          {rows.map((a) => (
            <button key={a.id} type="button" className="text-left" onClick={() => setOpen(a.id)}>
              <Card className="grid gap-1 active:bg-accent">
                <span className="truncate font-medium">{a.title}</span>
                <span className="flex items-center gap-2 text-xs text-muted-fg">
                  <Badge>{a.kind === "html" ? "HTML" : "Markdown"}</Badge>
                  <span className="min-w-0 flex-1 truncate">
                    v{a.currentVersion} · {a.projectId ? (titles.get(a.projectId) ?? a.projectId) : "No project"}
                  </span>
                  {ago(a.updatedAt)}
                </span>
              </Card>
            </button>
          ))}
        </Section>
      )}

      {more && rows && (
        <Button disabled={busy} onClick={() => void load(rows.at(-1))}>
          Older
        </Button>
      )}

      {open && <Viewer key={open} id={open} onClose={close} onChanged={() => void load()} />}
    </div>
  );
}

/** One artifact in a sheet: the page, its versions, a line diff against the previous version. */
function Viewer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null); // null = current
  const [diff, setDiff] = useState<{ from: number; to: number; lines: DiffLine[] } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call("GET /api/artifacts/:id", { params: { id }, query: version === null ? undefined : { version: String(version) } }).then(
      (d) => live && (setDetail(d), setError(null)),
      (e: unknown) => live && setError(message(e)),
    );
    return () => void (live = false);
  }, [id, version]);

  const shown = detail?.version.version;
  const previous = detail?.versions.find((v) => shown !== undefined && v.version < shown)?.version ?? null;
  useEffect(() => {
    setDiff(null);
    if (!comparing || shown === undefined || previous === null) return;
    let live = true;
    call("GET /api/artifacts/:id/diff", { params: { id }, query: { from: String(previous), to: String(shown) } }).then(
      (d) => live && setDiff(d),
      (e: unknown) => live && setError(message(e)),
    );
    return () => void (live = false);
  }, [id, comparing, shown, previous]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = () =>
    act(async () => {
      const d = await call("POST /api/artifacts/:id/restore", { params: { id }, body: { version: shown! } });
      setVersion(null);
      setDetail(d);
    });
  const archive = (next: boolean) =>
    act(async () => {
      const artifact = await call("POST /api/artifacts/:id/archive", { params: { id }, body: { archived: next } });
      setDetail((d) => d && { ...d, artifact });
    });

  const a = detail?.artifact;
  return (
    <Sheet title={a?.title ?? "Artifact"} onClose={onClose}>
      {error && <p className="mb-2 text-bad">{error}</p>}
      {!detail || !a ? (
        !error && <p className="text-muted-fg">Loading...</p>
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(detail.version.version)}
              aria-label="Version"
              className="w-auto flex-1"
              onChange={(e) => setVersion(Number(e.target.value) === a.currentVersion ? null : Number(e.target.value))}
            >
              {detail.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version} · {v.author} · {ago(v.createdAt)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant={comparing ? "primary" : "outline"} disabled={previous === null} aria-pressed={comparing} onClick={() => setComparing(!comparing)}>
              <GitCompare className="size-4" /> {previous === null ? "No earlier" : `Diff v${previous}`}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {shown !== a.currentVersion && (
              <Button size="sm" disabled={busy} onClick={() => void restore()}>
                <RotateCcw className="size-4" /> Restore v{shown}
              </Button>
            )}
            {a.archivedAt ? (
              <Button size="sm" disabled={busy} onClick={() => void archive(false)}>
                <ArchiveRestore className="size-4" /> Unarchive
              </Button>
            ) : (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void archive(true)}>
                <Archive className="size-4" /> Archive
              </Button>
            )}
          </div>

          {comparing && previous !== null ? (
            diff === null ? (
              <p className="text-muted-fg">Loading...</p>
            ) : (
              <pre className="max-h-[60dvh] overflow-auto rounded-lg border border-border bg-card p-2 font-mono text-xs leading-5">
                {diff.lines.map((l, i) => (
                  <div key={i} className={cn("whitespace-pre-wrap break-all", l.op === "+" && "bg-ok/15 text-ok", l.op === "-" && "bg-bad/15 text-bad")}>
                    {l.op} {l.text}
                  </div>
                ))}
              </pre>
            )
          ) : a.kind === "html" ? (
            // Opaque origin: no allow-same-origin, so the page cannot reach the CC cookie or API.
            <iframe
              title={a.title}
              srcDoc={detail.content}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              className="h-[60dvh] w-full rounded-lg border border-border bg-white"
            />
          ) : (
            <div className="min-w-0 break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-accent [&_pre]:p-2 [&_pre_code]:bg-transparent [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&>*+*]:mt-3">
              <Suspense fallback={<p className="text-muted-fg">Loading...</p>}>
                <Markdown text={detail.content} />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
