import { useCollectionDraft, useCollectionState } from "./collectionHooks.ts";
import { paginateCollection } from "./pagination.ts";
import { Pager } from "./ui/Pager.tsx";
import { Archive, ArchiveRestore, FileText, GitCompare, Plus, RotateCcw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Artifact, ArtifactDetail, DiffLine } from "../../server/artifacts.ts";
import { call } from "./api.ts";
import { projectColor } from "./look.ts";
import { splitProjectKey } from "./projectDirectory.ts";
import { useProjectIndex } from "./projectIndex.ts";
import { Button } from "./ui/Button.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Card, EmptyState, Input, Select, Textarea } from "./ui/fields.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Sheet } from "./ui/Sheet.tsx";
import { Tabs } from "./ui/Tabs.tsx";
import { useIsPhone } from "./ui/useIsPhone.ts";

const PAGE = 30;
/** Mirrors ARTIFACT_MAX_BYTES in server/artifacts.ts (a value import would pull server code into the bundle). */
const MAX_BYTES = 64 * 1024;

const message = (e: unknown) => (e instanceof Error ? e.message : "No se pudo completar la acción");
const kindLabel = (a: Artifact) => (a.kind === "html" ? "HTML" : "Markdown");

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
              {alt || (typeof src === "string" ? src : "imagen")}
            </a>
          ),
        }}
      >
        {text}
      </Md>
    ),
  };
});

/**
 * HTML and Markdown pages saved by you and your agents, with every version kept. Standalone under Proyectos / Artefactos
 * (list and viewer side by side on desktop), or pass `projectKey` ("<machineId>:<projectId>") to embed it filtered by one project.
 */
export function Artifacts({ projectKey }: { projectKey?: string }) {
  const index = useProjectIndex();
  const phone = useIsPhone();
  const split = !projectKey && !phone;
  const fixed = projectKey ? splitProjectKey(projectKey).projectId : null;
  const [picked, setPicked] = useCollectionState("artifacts.picked", "all"); // "all" | "none" | project id
  const project = fixed ?? picked;
  const [archived, setArchived] = useCollectionState("artifacts.archived", false);
  const [search, setSearch] = useCollectionState("artifacts.search", "");
  const [query, setQuery] = useState(search.trim());
  const [pageNumber, setPageNumber] = useCollectionState("artifacts.page", 1);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<Artifact[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useCollectionDraft<{ title: string; content: string } | null>(`artifacts.${projectKey ?? project}`, null);
  const [open, setOpen] = useCollectionState<string | null>("artifacts.open", null);
  const cancelDraft = () => {
    if (!busy && (!draft || confirm("¿Descartar el borrador sin guardar?"))) setDraft(null);
  };
  const seq = useRef(0);
  const [, setVersion] = useCollectionState("artifacts.version", "");
  const select = (id: string) => { setVersion(""); setOpen(id); };
  const close = useCallback(() => { setOpen(null); setVersion(""); }, [setOpen, setVersion]); // stable, so the sheet keeps its focus across reloads

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);

  const projectId = project === "all" ? undefined : project === "none" ? null : project;
  const load = async (after?: Artifact) => {
    const n = ++seq.current; // a slower, older response must not overwrite a newer filter
    setLoading(true);
    try {
      let page = await call("POST /api/artifacts/list", {
        body: { projectId, archived, query: query || undefined, limit: PAGE, before: after?.id, beforeUpdatedAt: after?.updatedAt },
      });
      if (n !== seq.current) return;
      const loaded = [...page.artifacts];
      while (!after && page.hasMore && loaded.length < pageNumber * PAGE) {
        const last = loaded.at(-1);
        if (!last) break;
        page = await call("POST /api/artifacts/list", { body: { projectId, archived, query: query || undefined, limit: PAGE, before: last.id, beforeUpdatedAt: last.updatedAt } });
        if (n !== seq.current) return;
        if (!page.artifacts.length) break;
        loaded.push(...page.artifacts);
      }
      setRows((prev) => (after && prev ? [...prev, ...loaded] : loaded));
      if (after) setPageNumber((p) => p + 1);
      setMore(page.hasMore);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(message(e));
    } finally { if (n === seq.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { seq.current++; }; }, [project, archived, query]);

  const tooBig = draft !== null && new TextEncoder().encode(draft.content).length > MAX_BYTES;
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await call("POST /api/artifacts", { body: { title: draft.title, content: draft.content, projectId: projectId ?? null } });
      setDraft(null);
      await load();
      select(saved.artifact.id);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  // Side by side, something is always open: the first row until you pick another.
  const shown = open ?? (split ? (rows?.[0]?.id ?? null) : null);
  const filtered = !!query || archived || (!fixed && project !== "all");

  const pagination = paginateCollection(rows ?? [], pageNumber, PAGE);
  const list =
    rows === null ? (
      error ? null : <p className="text-muted-fg">Cargando…</p>
    ) : rows.length === 0 ? (
      <EmptyState>{filtered ? "Sin elementos" : "Todavía no hay artefactos. Agrega uno o deja que un agente llame a artifact_save."}</EmptyState>
    ) : (
      <Panel className={split ? "rounded-none border-0 md:h-full" : undefined}>
        {pagination.items.map((a) => {
          const pk = a.projectId ? index.key(a.projectId) : null;
          const owner = a.projectId ? index.title(a.projectId) : "Sin proyecto";
          return (
            <button
              key={a.id}
              type="button"
              aria-current={shown === a.id}
              onClick={() => select(a.id)}
              style={{ "--pc": pk ? projectColor(pk) : "transparent" } as CSSProperties}
              className={cn(
                "flex w-full items-center gap-3 border-l-0 px-4 py-3 text-left md:border-l-4 md:border-l-[color:var(--pc)]",
                shown === a.id && split ? "bg-run-bg/40" : "active:bg-soft",
              )}
            >
              <FileText className="size-4 shrink-0 text-muted-fg" aria-hidden />
              <span className="grid min-w-0 flex-1">
                <span className="truncate font-semibold">{a.title}</span>
                <span className="truncate text-xs text-muted-fg">
                  {!fixed && owner}
                  <span className="md:hidden">
                    {!fixed && " · "}
                    {kindLabel(a)} · v{a.currentVersion} · {ago(a.updatedAt)}
                  </span>
                </span>
              </span>
              <span className="hidden w-20 shrink-0 text-xs text-muted-fg md:block">{kindLabel(a)}</span>
              <span className="hidden w-8 shrink-0 text-xs text-muted-fg tabular-nums md:block">v{a.currentVersion}</span>
              <span className="hidden w-20 shrink-0 whitespace-nowrap text-right text-xs text-muted-fg md:block">{ago(a.updatedAt)}</span>
            </button>
          );
        })}
        <div className="px-4 py-2"><Pager page={pagination} onPageChange={setPageNumber} label="Artefactos" /></div>
        <div className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs text-muted-fg">
          <span>Hasta 64 KB por versión</span>
          {more && rows && pagination.page === pagination.pageCount && (
            <Button size="sm" disabled={busy || loading} onClick={() => void load(rows.at(-1))}>
              Más antiguos
            </Button>
          )}
        </div>
      </Panel>
    );

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs label="Mostrar" value={archived ? "archived" : "active"} onChange={(id) => { setArchived(id === "archived"); setPageNumber(1, true); }} items={[{ id: "active", label: "Activos" }, { id: "archived", label: "Archivados" }]} />
        <span className="flex-1" />
        <Button disabled={busy} onClick={() => draft ? cancelDraft() : setDraft({ title: "", content: "" })} aria-expanded={draft !== null}>
          <Plus className="size-4" aria-hidden /> Nuevo artefacto
        </Button>
      </div>

      {draft && (
        <Card aria-busy={busy} className="grid gap-2">
          <Input disabled={busy} value={draft.title} maxLength={200} autoFocus placeholder="Título…" aria-label="Título" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <Textarea
            disabled={busy}
            value={draft.content}
            className="min-h-40 font-mono text-sm"
            placeholder="Pega HTML o Markdown…"
            aria-label="Contenido"
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
          />
          {tooBig && <p className="text-sm text-fail">Es demasiado grande: una versión de un artefacto admite hasta 64 KB.</p>}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={cancelDraft}>Cancelar</Button>
            <Button variant="primary" disabled={busy || tooBig || !draft.title.trim() || !draft.content.trim()} onClick={() => void save()}>
              {busy ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Input className="min-w-0 flex-1 md:max-w-sm" type="search" value={search} placeholder="Buscar por título…" aria-label="Buscar artefactos" onChange={(e) => { setSearch(e.target.value); setPageNumber(1, true); }} />
        {!fixed && (
          <Select className="w-auto max-w-full" value={picked} aria-label="Proyecto" onChange={(e) => { setPicked(e.target.value); setPageNumber(1, true); }}>
            <option value="all">Todos los proyectos</option>
            <option value="none">Sin proyecto</option>
            {index.list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </Select>
        )}
      </div>

      {error && <p role="alert" className="text-fail">{error}</p>}

      {split && rows && rows.length > 0 ? (
        <div className="grid min-h-[28rem] overflow-hidden rounded-card border border-line bg-panel lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0 overflow-y-auto border-line lg:max-h-[70dvh] lg:border-r">{list}</div>
          {shown && <Viewer key={shown} id={shown} inline onClose={close} onChanged={() => void load()} />}
        </div>
      ) : (
        list
      )}

      {open && !split && <Viewer key={open} id={open} onClose={close} onChanged={() => void load()} />}
    </div>
  );
}

/** One artifact: the page, its versions, a line diff against the previous version. A sheet, or a pane when `inline`. */
function Viewer({ id, inline, onClose, onChanged }: { id: string; inline?: boolean; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [version, setVersion] = useCollectionState("artifacts.version", "", (v) => v === "" || /^[1-9]\d{0,8}$/.test(v)); // empty = current
  const [, setOpen] = useCollectionState<string | null>("artifacts.open", null);
  const chooseVersion = (v: string) => { setOpen(id); setVersion(v); };
  const [diff, setDiff] = useState<{ from: number; to: number; lines: DiffLine[] } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    call("GET /api/artifacts/:id", { params: { id }, query: version === "" ? undefined : { version } }).then(
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
      setVersion("");
      setDetail(d);
    });
  const archive = (next: boolean) =>
    act(async () => {
      const artifact = await call("POST /api/artifacts/:id/archive", { params: { id }, body: { archived: next } });
      setDetail((d) => d && { ...d, artifact });
    });

  const a = detail?.artifact;
  const footer = detail && a && (
    <div className="flex flex-wrap items-center gap-2">
      {a.archivedAt ? (
        <Button disabled={busy} onClick={() => void archive(false)}>
          <ArchiveRestore className="size-4" aria-hidden /> Restaurar
        </Button>
      ) : (
        <Button variant="danger" disabled={busy} onClick={() => void archive(true)}>
          <Archive className="size-4" aria-hidden /> Archivar
        </Button>
      )}
      <Button variant={comparing ? "primary" : "outline"} disabled={previous === null} aria-pressed={comparing} onClick={() => setComparing(!comparing)}>
        <GitCompare className="size-4" aria-hidden /> {previous === null ? "Sin versión anterior" : `Diff v${previous}`}
      </Button>
      {shown !== a.currentVersion && (
        <Button variant="primary" disabled={busy} onClick={() => void restore()}>
          <RotateCcw className="size-4" aria-hidden /> Restaurar v{shown}
        </Button>
      )}
    </div>
  );

  const body: ReactNode = (
    <>
      {error && <p role="alert" className="mb-2 text-fail">{error}</p>}
      {!detail || !a ? (
        !error && <p className="text-muted-fg">Cargando…</p>
      ) : (
        <div className="grid gap-3">
          {comparing && previous !== null ? (
            diff === null ? (
              <p className="text-muted-fg">Cargando…</p>
            ) : (
              <pre className="max-h-[55dvh] overflow-auto rounded-ctl border border-line bg-panel p-2 font-mono text-xs leading-5">
                {diff.lines.map((l, i) => (
                  <div key={i} className={cn("break-all whitespace-pre-wrap", l.op === "+" && "bg-ok-bg text-ok", l.op === "-" && "bg-fail-bg text-fail")}>
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
              className="h-[55dvh] w-full rounded-ctl border border-line bg-white"
            />
          ) : (
            <div className="min-w-0 break-words [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-soft [&_code]:px-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-ctl [&_pre]:bg-soft [&_pre]:p-2 [&_pre_code]:bg-transparent [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-line [&_td]:px-2 [&_th]:border [&_th]:border-line [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5 [&>*+*]:mt-3">
              <Suspense fallback={<p className="text-muted-fg">Cargando…</p>}>
                <Markdown text={detail.content} />
              </Suspense>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-fg">
            <span>Versiones</span>
            {detail.versions.map((v) => (
              <button
                key={v.version}
                type="button"
                aria-pressed={v.version === shown}
                title={`${v.author} · ${ago(v.createdAt)}`}
                onClick={() => chooseVersion(v.version === a.currentVersion ? "" : String(v.version))}
                className={cn("rounded-full px-2.5 py-0.5 font-semibold", v.version === shown ? "bg-run-bg text-run" : "bg-soft text-tx2")}
              >
                v{v.version}
              </button>
            ))}
            <span className="ml-auto tabular-nums">
              {comparing && diff && previous !== null && shown !== undefined
                ? `diff v${previous} → v${shown}: +${diff.lines.filter((l) => l.op === "+").length} −${diff.lines.filter((l) => l.op === "-").length}`
                : `v${shown} · ${detail.version.author} · ${ago(detail.version.createdAt)}`}
            </span>
          </div>
        </div>
      )}
    </>
  );

  if (!inline)
    return (
      <Sheet title={a?.title ?? "Artefacto"} onClose={onClose} footer={footer || undefined} wide>
        {body}
      </Sheet>
    );
  return (
    <section className="flex min-w-0 flex-col" aria-label={a?.title ?? "Artefacto"}>
      <h2 className="border-b border-line px-4 py-3 font-semibold break-words">{a?.title ?? "Artefacto"}</h2>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
      {footer && <div className="border-t border-line px-4 py-3">{footer}</div>}
    </section>
  );
}
