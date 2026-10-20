import { FolderOpen, GitBranch, LayoutDashboard, MessageSquare, Search as SearchIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Sheet } from "./ui/Sheet.tsx";
import type { HomeView, MachineProjects } from "../../server/types.ts";
import { call, useLive } from "./api.ts";
import { matchesSearch } from "./homeQueueView.ts";
import { projectColor, statusTone } from "./look.ts";
import { hashes, pages, type Page } from "./navigation.ts";

interface Hit {
  id: string;
  group: string;
  label: string;
  sub: string;
  hash: string;
  icon: ReactNode;
}

const PER_GROUP = 6;
const icon = { task: GitBranch, thread: MessageSquare, project: FolderOpen, page: LayoutDashboard };
const searchable: Page[] = ["home", "work", "board", "flows", "projects", "artifacts", "memory", "money", "fleet", "agents", "notifications"];

/** Everything the live view knows (tasks, threads) plus projects and pages, grouped. Pure so it is cheap to re-run per keystroke. */
function findHits(query: string, view: HomeView | null, projects: MachineProjects[]): Hit[] {
  const machine = (id: string) => view?.machines.find((m) => m.id === id)?.label ?? "";
  const threads = [...(view?.needsYou.flatMap((n) => (n.kind === "thread" ? [n.thread] : [])) ?? []), ...(view?.running ?? []), ...(view?.done ?? [])];
  const seen = new Set<string>();
  const groups: [string, Hit[]][] = [
    ["Tareas", (view?.queue ?? []).filter((t) => matchesSearch(query, t.title, t.prompt, t.projectTitle, t.machineLabel)).map((t) => ({
      id: "task:" + t.id, group: "Tareas", label: t.title, sub: `${t.projectTitle} · ${statusTone(t.status).label}`, hash: hashes.task(t.id), icon: <icon.task className="size-4" aria-hidden />,
    }))],
    ["Hilos", threads.filter((t) => !seen.has(t.key) && seen.add(t.key) && matchesSearch(query, t.title, t.preview, machine(t.machineId))).map((t) => ({
      id: "thread:" + t.key, group: "Hilos", label: t.title, sub: `${machine(t.machineId)} · ${statusTone(t.status).label}`, hash: hashes.thread(t.key), icon: <icon.thread className="size-4" aria-hidden />,
    }))],
    ["Proyectos", projects.flatMap((g) => g.projects.filter((p) => matchesSearch(query, p.title, p.workspaceRoot, g.machineLabel)).map((p) => ({
      id: `project:${g.machineId}:${p.id}`, group: "Proyectos", label: p.title, sub: g.machineLabel, hash: hashes.project(`${g.machineId}:${p.id}`), icon: <icon.project className="size-4" style={{ color: projectColor(`${g.machineId}:${p.id}`) }} aria-hidden />,
    })))],
    ["Páginas", searchable.filter((p) => matchesSearch(query, pages[p].title, pages[p].label)).map((p) => ({
      id: "page:" + p, group: "Páginas", label: pages[p].title === pages[p].label ? pages[p].label : `${pages[p].title} · ${pages[p].label}`, sub: "", hash: hashes.page(p), icon: <icon.page className="size-4" aria-hidden />,
    }))],
  ];
  // With no query only the pages are shown, as quick navigation.
  return groups.flatMap(([group, hits]) => (query.trim() || group === "Páginas" ? hits.slice(0, PER_GROUP) : []));
}

/** Wraps each query word found in `text` in <mark>. */
function Highlight({ text, query }: { text: string; query: string }) {
  const words = query.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return <>{text}</>;
  return (
    <>
      {text.split(new RegExp(`(${words.join("|")})`, "i")).map((part, i) =>
        i % 2 ? <mark key={i} className="rounded-sm bg-need-bg text-inherit">{part}</mark> : part,
      )}
    </>
  );
}

/** Global search overlay ("/"): tasks, threads, projects and pages. Enter opens the highlighted hit. */
export function Search({ onClose }: { onClose: () => void }) {
  const { view } = useLive();
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<MachineProjects[]>([]);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const resultsId = useId();

  useEffect(() => {
    call("GET /api/projects").then(setProjects, () => {});
    const frame = requestAnimationFrame(() => {
      if (matchMedia("(hover: hover) and (pointer: fine)").matches) input.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const hits = useMemo(() => findHits(query, view, projects), [query, view, projects]);
  const current = Math.min(active, Math.max(0, hits.length - 1));
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, hits]);

  const open = (hit: Hit | undefined) => {
    if (!hit) return;
    onClose();
    location.hash = hit.hash;
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target !== input.current || e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % Math.max(1, hits.length));
    } else if (e.key === "Enter") { e.preventDefault(); open(hits[current]); }
  };

  return (
    <Sheet title="Buscar" onClose={onClose} wide>
      <div onKeyDown={onKey} className="flex min-h-0 flex-col">
        <div className="flex items-center gap-3 rounded-ctl border border-line px-3 focus-within:ring-2 focus-within:ring-primary">
          <SearchIcon className="size-4 shrink-0 text-muted-fg" aria-hidden />
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={resultsId}
            aria-autocomplete="list"
            aria-activedescendant={hits.length ? `${resultsId}-${current}` : undefined}
            aria-label="Buscar tareas, hilos y proyectos"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            placeholder="Buscar tareas, hilos y proyectos…"
            name="search"
            autoComplete="off"
            spellCheck={false}
            className="h-12 min-w-0 flex-1 bg-transparent placeholder:text-muted-fg"
          />
          <kbd className="hidden text-muted-fg md:inline-block">esc</kbd>
        </div>
        <p role="status" className="sr-only">{hits.length} resultados</p>
        {!hits.length && <p className="p-6 text-center text-muted-fg">{query.trim() ? `No hay resultados para “${query.trim()}”. Prueba con un proyecto, una tarea o una página.` : "Sin resultados"}</p>}
        <ul id={resultsId} ref={list} role="listbox" aria-label="Resultados de búsqueda" className="max-h-[50dvh] min-h-0 flex-1 overflow-y-auto py-1">
          {hits.map((hit, i) => (
            <li key={hit.id} role="presentation">
              {(i === 0 || hits[i - 1]!.group !== hit.group) && <p className="px-4 pt-3 pb-1 text-xs font-semibold tracking-wide text-muted-fg uppercase">{hit.group}</p>}
              <a
                id={`${resultsId}-${i}`}
                href={hit.hash}
                role="option"
                aria-selected={i === current}
                onMouseMove={() => setActive(i)}
                onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) onClose(); }}
                className={`flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-soft ${i === current ? "bg-[#f5f8ff]" : ""}`}
              >
                <span className="text-muted-fg">{hit.icon}</span>
                <span className="min-w-0 flex-1 truncate"><Highlight text={hit.label} query={query} /></span>
                <span className="max-w-[40%] truncate text-xs text-muted-fg">{hit.sub}</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="hidden border-t border-line px-4 py-2 text-xs text-muted-fg md:block">↑↓ elegir · ↵ abrir · esc cerrar</p>
      </div>
    </Sheet>
  );
}
