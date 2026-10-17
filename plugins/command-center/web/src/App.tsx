/*
 * App: auth gate, hash routing, global shortcuts and the overlays. Chrome (sidebar, top bar, tab bar) is Shell.tsx;
 * hashes are parsed by navigation.ts (parseRoute / hashes), the single source of truth for the scheme below.
 *
 * Routes (hash):
 *   #home                                   Hoy
 *   #work  #work/board  #work/flows         Trabajo: Lista, Tablero, Flujos
 *   #work?task=<id>                         Lista with that task open (push links #item=task:<id>)
 *   #work/flows?run=<id>                    Flujos with that run open (push links #item=workflow:<run>:<node>)
 *   #projects  #projects/artifacts  #projects/memory     Proyectos: Todos, Artefactos, Memoria
 *   #project/<machineId:projectId>[?tab=work|sections|artifacts|memory]    PROJECT DETAIL
 *   #money  #fleet  #fleet/agents  #fleet/notifications  #more  #pair
 * Overlays render on top of the last real page and close with location.replace(thatPage):
 *   #ask[?project=<key>][&dictate=1]        Pedir (also Ctrl/Cmd+K, the sidebar button, the phone mic)
 *   #item=<ThreadItem.key>                  ThreadSheet (approvals). Rows link to hashes.thread(key).
 * "/" opens Search (state, not a hash). Older hashes (#queue, #workflows, #finance, #machines ...) still resolve.
 *
 * Project detail: a separate page ("project", under Proyectos) with its own hash, not a sub-tab, so it can be linked,
 * pushed and reached with the back button. Projects.tsx renders BOTH the list (projectKey = null) and the detail
 * (projectKey set, tab = Resumen/Trabajo/Secciones/Artefactos/Memoria); the detail tabs are drawn by the screen
 * (use Tabs with hashes.project(key, tab) hrefs). The shell only draws "‹ Proyectos", search and the bell there.
 *
 * Screen props (every screen renders inside the shell content area; the shell draws title, sub-tabs, search):
 *   Home()                                      Hoy
 *   Work({ taskId: string | null })             Trabajo / Lista (absorbs Queue.tsx)
 *   Board()                                     Trabajo / Tablero
 *   Workflows({ runId?: string | null })        Trabajo / Flujos
 *   Projects({ projectKey: string | null, tab: ProjectTab })   Proyectos / Todos and project detail
 *   Artifacts()  Memory()                       Proyectos / Artefactos, Memoria
 *   Finance()                                   Dinero
 *   Fleet()                                     Flota / Máquinas (Machines + Infra + lanes per machine)
 *   Agents()                                    Flota / Agentes (Perfiles + Acceso API)
 *   Notifications()                             Flota / Notificaciones
 *   Pair()                                      Standalone (no shell): shown while not paired
 *   Ask({ project: string | null, onClose, autoDictate })   Overlay; renders its own Sheet
 *   ThreadSheet({ item: ThreadItem, view: HomeView, onClose })   Overlay; renders its own Sheet
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Agents } from "./Agents.tsx";
import { Artifacts } from "./Artifacts.tsx";
import { Assistant } from "./Assistant.tsx";
import { NewRequest } from "./NewRequest.tsx";
import { Board } from "./Board.tsx";
import { Finance } from "./Finance.tsx";
import { Fleet } from "./Fleet.tsx";
import { Home } from "./Home.tsx";
import { Memory } from "./Memory.tsx";
import { Notifications } from "./Notifications.tsx";
import { Pair } from "./Pair.tsx";
import { Projects } from "./Projects.tsx";
import { Search } from "./Search.tsx";
import { KeyboardHelp, More, Shell } from "./Shell.tsx";
import { ThreadSheet } from "./ThreadSheet.tsx";
import { Work } from "./Work.tsx";
import { Workflows } from "./Workflows.tsx";
import { connect, useHash, useLive } from "./api.ts";
import { homeThread } from "./homeQueueView.ts";
import { isShortcutEditing, parseRoute, resolveShortcut } from "./navigation.ts";
import { syncPush } from "./push.ts";
import { Toaster, toast } from "./ui/Toast.tsx";

const openAsk = (dictate: boolean) => {
  const route = parseRoute(location.hash);
  if (route.page === "project" && route.tab === "chat") {
    if (dictate) dispatchEvent(new Event("cc:project-dictate"));
    else document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Mensaje al orquestador"]')?.focus();
    return;
  }
  const query = new URLSearchParams();
  if (route.projectKey) query.set("project", route.projectKey);
  if (dictate) query.set("dictate", "1");
  location.hash = `#ask${query.size ? `?${query}` : ""}`;
};

export function App() {
  const hash = useHash();
  const { view, authed } = useLive();
  // The pair link is /pair#token=...; a pasted token lands on #pair.
  const pairing = location.pathname === "/pair" || hash.startsWith("#pair") || new URLSearchParams(hash.slice(1)).has("token");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Overlays sit on the last real page, so remember it.
  const parsed = parseRoute(hash);
  const base = useRef("#home");
  if (!parsed.overlay) base.current = hash || "#home";
  const route = parsed.overlay ? parseRoute(base.current) : parsed;
  const closeOverlay = () => location.replace(base.current);

  useEffect(connect, []);
  useEffect(() => {
    if (authed) void syncPush().catch(() => {});
  }, [authed]);
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
      const action = result.action;
      if (action.type === "help") setHelpOpen(true);
      else if (action.type === "search") setSearchOpen(true);
      else if (action.type === "ask") openAsk(false);
      else if (action.route === "ask") openAsk(false);
      else location.hash = action.route;
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

  const overlay = parsed.overlay;
  const thread = overlay?.type === "thread" && view ? homeThread(view, overlay.key) : undefined;
  const threadGone = overlay?.type === "thread" && !!view && !thread;
  useEffect(() => {
    if (!threadGone) return;
    toast("Ese hilo ya no está en la vista.");
    location.replace(base.current);
  }, [threadGone]);

  if (pairing || authed === false) return <Pair />;
  if (authed === null) return <p className="p-6 text-muted-fg">Cargando…</p>;

  let page: ReactNode;
  switch (route.page) {
    case "home": page = <Home />; break;
    case "work": page = <Work taskId={route.taskId} />; break;
    case "board": page = <Board />; break;
    case "flows": page = <Workflows key={route.runId ?? ""} runId={route.runId} />; break;
    case "projects":
    case "project": page = <Projects projectKey={route.projectKey} tab={route.tab} />; break;
    case "artifacts": page = <Artifacts />; break;
    case "memory": page = <Memory />; break;
    case "money": page = <Finance />; break;
    case "fleet": page = <Fleet />; break;
    case "agents": page = <Agents />; break;
    case "notifications": page = <Notifications />; break;
    case "more": page = <More view={view} />; break;
  }

  return (
    <>
      <Shell onAssistant={() => setAssistantOpen(true)} page={route.page} view={view} onAsk={openAsk} onSearch={() => setSearchOpen(true)} onHelp={() => setHelpOpen(true)}>
        {page}
      </Shell>
      {overlay?.type === "ask" && <NewRequest key={overlay.project ?? ""} project={overlay.project} autoDictate={overlay.dictate} onClose={closeOverlay} />}
      {thread && view && <ThreadSheet item={thread} view={view} onClose={closeOverlay} />}
      {searchOpen && <Search onClose={() => setSearchOpen(false)} />}
      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
      <Assistant open={assistantOpen} onClose={() => setAssistantOpen(false)} />
      <Toaster />
    </>
  );
}
