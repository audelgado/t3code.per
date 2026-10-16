// Information architecture: 5 destinations, their pages, the hash scheme and the keyboard shortcuts.
// Pure (no DOM, no React) so it is unit tested. App.tsx and Shell.tsx render from it.

export type Dest = "home" | "work" | "projects" | "money" | "fleet";
export type Page = "home" | "work" | "board" | "flows" | "projects" | "project" | "artifacts" | "memory" | "money" | "fleet" | "agents" | "notifications" | "more";

/** `label` is the sub-tab / list label; `title` and `description` are the page header (the shell draws it). */
export const pages: Record<Page, { dest: Dest | null; hash: string; label: string; title: string; description: string }> = {
  home: { dest: "home", hash: "home", label: "Hoy", title: "Hoy", description: "" },
  work: { dest: "work", hash: "work", label: "Lista", title: "Trabajo", description: "Cada tarea y rama, de la cola a la limpieza." },
  board: { dest: "work", hash: "work/board", label: "Tablero", title: "Trabajo", description: "Cada tarea y rama, de la cola a la limpieza." },
  flows: { dest: "work", hash: "work/flows", label: "Flujos", title: "Trabajo", description: "Procesos repetibles y sus ejecuciones." },
  projects: { dest: "projects", hash: "projects", label: "Todos", title: "Proyectos", description: "Encontrá un proyecto y seguí trabajando." },
  project: { dest: "projects", hash: "projects", label: "Proyecto", title: "Proyecto", description: "" },
  artifacts: { dest: "projects", hash: "projects/artifacts", label: "Artefactos", title: "Proyectos", description: "Lo que produjo tu trabajo." },
  memory: { dest: "projects", hash: "projects/memory", label: "Memoria", title: "Proyectos", description: "Lo que guardaron los agentes y vos." },
  money: { dest: "money", hash: "money", label: "Dinero", title: "Dinero", description: "Ingresos, costos y presupuestos." },
  fleet: { dest: "fleet", hash: "fleet", label: "Máquinas", title: "Flota", description: "Máquinas, agentes y este dispositivo." },
  agents: { dest: "fleet", hash: "fleet/agents", label: "Agentes", title: "Flota", description: "Perfiles y acceso API para tus agentes." },
  notifications: { dest: "fleet", hash: "fleet/notifications", label: "Notificaciones", title: "Flota", description: "Avisos en este dispositivo." },
  more: { dest: null, hash: "more", label: "Más", title: "Más", description: "" },
};

export const destinations: readonly { id: Dest; label: string; pages: readonly Page[] }[] = [
  { id: "home", label: "Hoy", pages: ["home"] },
  { id: "work", label: "Trabajo", pages: ["work", "board", "flows"] },
  { id: "projects", label: "Proyectos", pages: ["projects", "artifacts", "memory"] },
  { id: "money", label: "Dinero", pages: ["money"] },
  { id: "fleet", label: "Flota", pages: ["fleet", "agents", "notifications"] },
];

/** The destination a page lives under (project detail lives under Proyectos); null for Más. */
export const destOf = (page: Page): Dest | null => pages[page].dest;

/** Sub-tabs of the page's destination; empty for Hoy, Dinero and project detail. */
export const subPages = (page: Page): readonly Page[] => {
  const list = page === "project" ? [] : (destinations.find((d) => d.id === destOf(page))?.pages ?? []);
  return list.length > 1 ? list : [];
};

/** Phone bottom tab that lights up for a page. Dinero, Flota, Agentes and Notificaciones live under Más. */
export const phoneTab = (page: Page): "home" | "work" | "projects" | "more" => {
  const dest = destOf(page);
  return dest === "home" || dest === "work" || dest === "projects" ? dest : "more";
};

// ---- hash scheme ----
//   #home  #work  #work/board  #work/flows[?run=<id>]  #work?task=<id>
//   #projects  #projects/artifacts  #projects/memory  #project/<machineId:projectId>[?tab=work|sections|artifacts|memory]
//   #money  #fleet  #fleet/agents  #fleet/notifications  #more  #pair
// Overlays (they render over the last real page): #ask[?project=<key>][&dictate=1]  #item=<ThreadItem.key>
// Push links and older hashes still resolve: #item=task:<id> #item=workflow:<run>:<node> #item=alert:<key> #queue #workflows?run= ...

export const PROJECT_TABS = [
  ["overview", "Resumen"],
  ["work", "Trabajo"],
  ["sections", "Secciones"],
  ["artifacts", "Artefactos"],
  ["memory", "Memoria"],
] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number][0];

export type Overlay = { type: "ask"; project: string | null; dictate: boolean } | { type: "thread"; key: string };

export interface Route {
  page: Page;
  /** Task to open on the Lista (#work?task=<id>). */
  taskId: string | null;
  /** Workflow run to open on Flujos. */
  runId: string | null;
  /** "<machineId>:<projectId>" on project detail. */
  projectKey: string | null;
  tab: ProjectTab;
  overlay: Overlay | null;
}

const route = (page: Page, rest: Partial<Route> = {}): Route => ({ page, taskId: null, runId: null, projectKey: null, tab: "overview", overlay: null, ...rest });

/** First hash segment -> page; older names (queue, finance, machines ...) still resolve. */
const aliases: Record<string, Page> = {
  home: "home", work: "work", queue: "work", workflows: "flows", projects: "projects", sections: "projects", artifacts: "artifacts", memory: "memory",
  money: "money", finance: "money", fleet: "fleet", machines: "fleet", infra: "fleet", agents: "agents", profiles: "agents", notifications: "notifications", more: "more",
};

export function parseRoute(hash: string): Route {
  let [path = "", qs = ""] = hash.replace(/^#/, "").split("?");
  if (path.includes("=")) [path, qs] = ["", path]; // "#item=..." has no path
  const query = new URLSearchParams(qs);
  const [head = "", sub, ...tail] = path.split("/");

  const item = query.get("item");
  if (item !== null) {
    if (item.startsWith("task:")) return route("work", { taskId: item.slice(5) });
    if (item.startsWith("workflow:")) return route("flows", { runId: item.split(":")[1] ?? null });
    if (item.startsWith("alert:")) return route("home");
    return route("home", { overlay: { type: "thread", key: item } });
  }
  if (head === "ask") return route("home", { overlay: { type: "ask", project: query.get("project"), dictate: query.has("dictate") } });
  if (head === "project") {
    const key = decodeURIComponent([sub, ...tail].filter((s) => s !== undefined).join("/"));
    if (!key) return route("projects");
    const tab = PROJECT_TABS.find(([id]) => id === query.get("tab"))?.[0] ?? "overview";
    return route("project", { projectKey: key, tab });
  }

  const base = aliases[head] ?? "home";
  const page: Page = base === "work" ? (sub === "board" ? "board" : sub === "flows" ? "flows" : "work")
    : base === "projects" ? (sub === "artifacts" ? "artifacts" : sub === "memory" ? "memory" : "projects")
    : base === "fleet" ? (sub === "agents" ? "agents" : sub === "notifications" ? "notifications" : "fleet")
    : base;
  return route(page, { taskId: page === "work" ? query.get("task") : null, runId: page === "flows" ? query.get("run") : null });
}

export const hashes = {
  page: (page: Page) => "#" + pages[page].hash,
  project: (key: string, tab?: ProjectTab) => `#project/${encodeURIComponent(key)}${tab && tab !== "overview" ? `?tab=${tab}` : ""}`,
  task: (id: string) => `#work?task=${encodeURIComponent(id)}`,
  run: (id: string) => `#work/flows?run=${encodeURIComponent(id)}`,
  thread: (key: string) => `#item=${encodeURIComponent(key)}`,
  ask: (project?: string | null) => (project ? `#ask?project=${encodeURIComponent(project)}` : "#ask"),
};

// ---- keyboard ----

/** g then a key, within 1.5 s. Values are hash paths (or "ask", which opens the global Pedir overlay). */
export const navigationKeys = {
  h: "home", t: "work", w: "work", b: "work/board", p: "projects", r: "projects/artifacts", m: "projects/memory",
  d: "money", f: "fleet", n: "fleet/notifications", a: "ask",
} as const;

interface ShortcutContext {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  editable?: boolean;
  dialogOpen?: boolean;
  defaultPrevented?: boolean;
}

export type ShortcutAction = { type: "navigate"; route: string } | { type: "search" } | { type: "help" } | { type: "ask" };

/**
 * "/" opens search, "?" help, Ctrl/Cmd+K opens Pedir (works while typing, not over a dialog),
 * and a short g-prefix sequence navigates; interrupted or blocked input always clears it.
 */
export function resolveShortcut(event: ShortcutContext, prefixAt: number | null, now: number): { prefixAt: number | null; action?: ShortcutAction } {
  const clear = { prefixAt: null };
  if (event.defaultPrevented || event.dialogOpen || event.repeat || event.isComposing) return clear;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") return { ...clear, action: { type: "ask" } };
  if (event.editable || event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== "?" && event.key !== "/")) return clear;
  if (event.key === "?") return { ...clear, action: { type: "help" } };
  if (event.key === "/") return { ...clear, action: { type: "search" } };
  if (prefixAt !== null && now >= prefixAt && now - prefixAt <= 1500 && Object.hasOwn(navigationKeys, event.key)) {
    return { ...clear, action: { type: "navigate", route: navigationKeys[event.key as keyof typeof navigationKeys] } };
  }
  return { prefixAt: event.key === "g" ? now : null };
}

/** Walk ancestors so nested rich text and controls inside buttons keep their keys. */
export function isShortcutEditing(target: { closest: (selector: string) => unknown } | null) {
  return !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]');
}
