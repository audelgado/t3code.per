import { ChevronLeft, ChevronRight, Ellipsis, GitBranch, House, Keyboard, ListTodo, Send } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Agents } from "./Agents.tsx";
import { Artifacts } from "./Artifacts.tsx";
import { Ask } from "./Ask.tsx";
import { Finance } from "./Finance.tsx";
import { Home } from "./Home.tsx";
import { Infra } from "./Infra.tsx";
import { Machines } from "./Machines.tsx";
import { Memory } from "./Memory.tsx";
import { Notifications } from "./Notifications.tsx";
import { Orca } from "./Orca.tsx";
import { Pair } from "./Pair.tsx";
import { Profiles } from "./Profiles.tsx";
import { Projects } from "./Projects.tsx";
import { Queue } from "./Queue.tsx";
import { Sections } from "./Sections.tsx";
import { Work } from "./Work.tsx";
import { Workflows } from "./Workflows.tsx";
import { connect, parseHash, useHash, useLive } from "./api.ts";
import { syncPush } from "./push.ts";
import { cn } from "./ui/cn.ts";
import { isShortcutEditing, navigationKeys, primaryNavigationRoutes, resolveShortcut, visibleNavigation, type SecondaryNavigationRoute } from "./navigation.ts";

const primaryTabs = {
  home: { label: "Home", icon: House },
  ask: { label: "Ask", icon: Send },
  queue: { label: "Queue", icon: ListTodo },
  work: { label: "Work", icon: GitBranch },
};
const tabs = [
  ...primaryNavigationRoutes.map((route) => ({ route, ...primaryTabs[route] })),
  { route: "more", label: "More", icon: Ellipsis },
] as const;

// Pages under More; their hashes (#projects, #memory, ...) are handled here, not in api.ts.
const secondaryPages = {
  projects: Projects,
  memory: Memory,
  sections: Sections,
  profiles: Profiles,
  finance: Finance,
  workflows: Workflows,
  artifacts: Artifacts,
  infra: Infra,
  orca: Orca,
  machines: Machines,
  agents: Agents,
  notifications: Notifications,
} satisfies Record<SecondaryNavigationRoute, ComponentType>;
const more = Object.entries(secondaryPages).map(([route, page]) => ({ route, page }));

function More({ orca }: { orca: boolean }) {
  return (
    <nav aria-label="More" className="space-y-5">
      {visibleNavigation(orca, "more").map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h2 className="mb-2 text-xs font-semibold text-muted-fg">{group.label}</h2>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {group.items.map(({ route, label }) => (
              <a key={route} href={"#" + route} className="flex items-center justify-between px-4 py-3 text-sm hover:bg-accent active:bg-accent">
                {label}
                <ChevronRight className="size-4 text-muted-fg" aria-hidden />
              </a>
            ))}
          </div>
        </section>
      ))}
    </nav>
  );
}

function focusSearch() {
  const inputs = document.querySelectorAll<HTMLInputElement>(
    'main input[type="search"], main input[role="searchbox"], main input[aria-label*="search" i], main input[placeholder*="search" i], main [role="search"] input',
  );
  const input = Array.from(inputs).find((input) => !input.disabled && !input.readOnly && input.getClientRects().length > 0);
  input?.focus();
  return !!input;
}

function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="shortcut-title"
      aria-describedby="shortcut-description"
      className="shortcut-dialog"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 id="shortcut-title" className="text-lg font-semibold">Keyboard shortcuts</h2>
        <button type="button" autoFocus onClick={onClose} className="rounded-lg border border-input px-3 py-2 hover:bg-accent">Close</button>
      </div>
      <p id="shortcut-description" className="mb-4 text-sm text-muted-fg">Press g, then a destination key within 1.5 seconds. Shortcuts pause while typing or using a dialog.</p>
      <dl className="space-y-2 text-sm">
        {Object.entries(navigationKeys).map(([key, route]) => (
          <div key={key} className="flex justify-between gap-4">
            <dt>Go to {route[0]!.toUpperCase() + route.slice(1)}</dt>
            <dd><kbd>g</kbd> <kbd>{key}</kbd></dd>
          </div>
        ))}
        <div className="flex justify-between gap-4"><dt>Focus search (or go to Projects)</dt><dd><kbd>/</kbd></dd></div>
        <div className="flex justify-between gap-4"><dt>Show shortcuts</dt><dd><kbd>?</kbd></dd></div>
        <div className="flex justify-between gap-4"><dt>Close this help</dt><dd><kbd>Escape</kbd></dd></div>
      </dl>
    </dialog>
  );
}

export function App() {
  const hash = useHash();
  const { view, authed } = useLive();
  const { route, query } = parseHash(hash);
  // The pair link is /pair#token=...; a pasted token lands on #pair.
  const pairing = location.pathname === "/pair" || route === "pair" || new URLSearchParams(hash.slice(1)).has("token");

  // Orca shows under More only when the server has CC_ORCA_CLI.
  const [orca, setOrca] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const searchAfterNavigation = useRef(false);
  useEffect(connect, []);
  useEffect(() => {
    if (!authed || pairing) return;
    let prefixAt: number | null = null;
    const keydown = (event: KeyboardEvent) => {
      const dialogOpen = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"]'))
        .some((dialog) => dialog.getClientRects().length > 0);
      const result = resolveShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: event.isComposing,
        defaultPrevented: event.defaultPrevented,
        editable: isShortcutEditing(event.target instanceof Element ? event.target : null),
        dialogOpen,
      }, prefixAt, Date.now());
      prefixAt = result.prefixAt;
      if (!result.action) return;
      event.preventDefault();
      if (result.action.type === "help") setHelpOpen(true);
      else if (result.action.type === "navigate") location.hash = result.action.route;
      else if (!focusSearch()) {
        searchAfterNavigation.current = true;
        location.hash = "projects";
      }
    };
    const reset = () => { prefixAt = null; };
    addEventListener("keydown", keydown);
    addEventListener("blur", reset);
    addEventListener("hashchange", reset);
    return () => {
      removeEventListener("keydown", keydown);
      removeEventListener("blur", reset);
      removeEventListener("hashchange", reset);
    };
  }, [authed, pairing]);
  useEffect(() => {
    if (!searchAfterNavigation.current) return;
    searchAfterNavigation.current = false;
    const frame = requestAnimationFrame(focusSearch);
    return () => cancelAnimationFrame(frame);
  }, [hash]);
  useEffect(() => {
    if (!authed) return;
    void syncPush().catch(() => {});
    void fetch("/api/features", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((f: { orca?: boolean } | null) => setOrca(f?.orca === true))
      .catch(() => {});
  }, [authed]);

  if (pairing || authed === false) return <Pair />;
  if (authed === null) return <p className="p-6 text-muted-fg">Loading...</p>;

  const badge = (r: string) =>
    r === "home" ? (view?.needsYou.length ?? 0) : r === "queue" ? (view?.queue.filter((t) => t.status === "queued" || t.status === "pending_approval").length ?? 0) : 0;
  // Push links: #item=<ThreadItem.key> | task:<taskId> | alert:<alertKey> | workflow:<runId>:<node>.
  const item = new URLSearchParams(hash.slice(1)).get("item");
  const name = hash.slice(1).split("?")[0];
  const sub = more.find((s) => s.route === name && (orca || s.route !== "orca"));
  // #workflows?run=<id> and workflow push links open that run.
  const runId = item?.startsWith("workflow:") ? item.split(":")[1]! : name === "workflows" ? query.get("run") : null;
  let active: string = route;
  let page: ReactNode;
  if (item?.startsWith("task:")) [active, page] = ["queue", <Queue />];
  else if (runId) [active, page] = ["more", <Workflows key={runId} runId={runId} />];
  else if (item !== null) [active, page] = ["home", <Home openKey={item.startsWith("alert:") ? null : item} />];
  else if (sub) {
    active = "more";
    page = (
      <>
        <a href="#more" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-fg lg:hidden">
          <ChevronLeft className="size-4" aria-hidden />
          More
        </a>
        <sub.page />
      </>
    );
  } else if (name === "work") [active, page] = ["work", <Work />];
  else if (name === "more") [active, page] = ["more", <More orca={orca} />];
  else if (route === "ask") page = <Ask project={query.get("project")} />;
  else if (route === "queue") page = <Queue />;
  else page = <Home openKey={null} />;

  // Desktop (lg): a sidebar with every page replaces the bottom tabs and the More list.
  const current = item?.startsWith("task:") ? "queue" : runId ? "workflows" : item !== null ? "home" : sub?.route ?? active;
  const groups = visibleNavigation(orca);
  const group = groups.find((group) => group.items.some((item) => item.route === current));
  const section = group?.items.find((item) => item.route === current);
  const online = view?.machines.filter((machine) => machine.link.status === "online").length ?? 0;
  const sideLink = (r: string, label: string, Icon?: (typeof tabs)[number]["icon"]) => {
    const n = badge(r);
    return (
      <a
        key={r}
        href={`#${r}`}
        aria-current={current === r ? "page" : undefined}
        className={cn(
          "flex items-center gap-2.5 rounded-lg px-3 py-1.5",
          current === r ? "bg-accent font-medium text-primary" : "text-muted-fg hover:bg-accent hover:text-fg",
        )}
      >
        {Icon && <Icon className="size-4" aria-hidden />}
        <span className="min-w-0 flex-1">{label}</span>
        {r === "machines" && view && <span className="text-xs text-muted-fg" aria-label={`${online} machines online`}>{online} online</span>}
        {n > 0 && <span className="min-w-5 rounded-full bg-warn px-1.5 text-center text-xs leading-5 text-bg">{n}</span>}
      </a>
    );
  };

  return (
    <div className="flex min-h-dvh">
      <a href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }} className="skip-link">Skip to content</a>
      <nav aria-label="Pages" className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3 lg:flex">
        <span className="px-3 pt-1 pb-3 font-semibold">Command Center</span>
        <a href="#ask" aria-current={current === "ask" ? "page" : undefined} className="mb-2 flex items-center gap-2 rounded-lg bg-primary px-3 py-2 font-medium text-primary-fg hover:opacity-90"><Send className="size-4" aria-hidden />Ask an agent</a>
        {visibleNavigation(orca, "desktop").map((group) => <section key={group.label} aria-label={group.label} className="mb-2">
          <h2 className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-fg">{group.label}</h2>
          {group.items.map((item) => sideLink(item.route, item.label, tabs.find((tab) => tab.route === item.route)?.icon))}
        </section>)}
        <button type="button" onClick={() => setHelpOpen(true)} className="mt-auto flex items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-fg hover:bg-accent hover:text-fg"><Keyboard className="size-4" aria-hidden />Keyboard shortcuts <kbd className="ml-auto">?</kbd></button>
      </nav>
      <div className="mx-auto flex w-full min-w-0 max-w-xl flex-1 flex-col lg:max-w-6xl">
      <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-24 lg:px-6 lg:pt-5 lg:pb-8">
        <header className="mb-4 flex min-w-0 items-start justify-between gap-3 border-b border-border pb-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-fg">{group?.label ?? "Navigation"}</p>
            {section && <p className="mt-1 text-sm text-muted-fg">{section.description}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1 lg:hidden">
            {current !== "ask" && <a href="#ask" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg"><Send className="size-4" aria-hidden />Ask</a>}
            <button type="button" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts" className="rounded-lg p-2 text-muted-fg hover:bg-accent hover:text-fg"><Keyboard className="size-4" aria-hidden /></button>
          </div>
        </header>
        {current === "more" && <h1 className="mb-4 text-xl font-semibold">More</h1>}
        {page}
      </main>
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-bg pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <div className="mx-auto flex max-w-xl">
          {tabs.map(({ route: r, label, icon: Icon }) => {
            const n = badge(r);
            return (
              <a
                key={r}
                href={`#${r}`}
                aria-current={active === r ? "page" : undefined}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-0.5 py-2 text-xs",
                  active === r ? "font-medium text-primary" : "text-muted-fg",
                )}
              >
                <Icon className="size-5" aria-hidden />
                {label}
                {n > 0 && (
                  <span className="absolute top-1 left-1/2 ml-2 min-w-4 rounded-full bg-warn px-1 text-center text-[10px] leading-4 text-bg">
                    {n}
                  </span>
                )}
              </a>
            );
          })}
        </div>
      </nav>
      </div>
      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
