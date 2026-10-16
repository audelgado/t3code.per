import { Bell, Brain, ChevronRight, Ellipsis, FileText, Folder, GitBranch, House, Keyboard, LogOut, Mic, Search, Server, Sparkles, Wallet } from "lucide-react";
import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import type { HomeView } from "../../server/types.ts";
import { call, connect } from "./api.ts";
import { needsCount } from "./homeQueueView.ts";
import { StatusDot } from "./StatusDot.tsx";
import { destinations, destOf, hashes, navigationKeys, pages, phoneTab, subPages, type Dest, type Page } from "./navigation.ts";
import { Tabs } from "./ui/Tabs.tsx";
import { cn } from "./ui/cn.ts";

const destIcon: Record<Dest, ComponentType<{ className?: string }>> = { home: House, work: GitBranch, projects: Folder, money: Wallet, fleet: Server };
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const askHint = isMac ? "⌘K" : "Ctrl K";

const pageName = (p: Page) => (pages[p].title === pages[p].label ? pages[p].label : `${pages[p].title} · ${pages[p].label}`);
const today = () => {
  const s = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  return s[0]!.toUpperCase() + s.slice(1);
};

function Logo({ className }: { className?: string }) {
  return <span aria-hidden className={cn("grid size-[26px] shrink-0 place-items-center rounded-lg bg-fg text-[11px] font-bold text-white", className)}>CC</span>;
}

/** Desktop sidebar: Pedir, the five destinations (sub-pages under the active one) and the machines at a glance. */
function Sidebar({ page, view, onAsk, onHelp }: { page: Page; view: HomeView | null; onAsk: () => void; onHelp: () => void }) {
  const dest = destOf(page);
  return (
    <nav aria-label="Navegación" className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-side px-2.5 py-3.5 md:flex">
      <div className="flex items-center gap-2 px-1.5 pb-3 font-semibold"><Logo />Command Center</div>
      <button type="button" onClick={onAsk} className="mb-2.5 flex h-9 items-center gap-2 rounded-[10px] bg-primary px-3 font-semibold text-primary-fg active:opacity-90">
        <Sparkles className="size-4" aria-hidden />Pedir<kbd className="ml-auto border-white/30 text-[11px] font-normal text-white/80">{askHint}</kbd>
      </button>
      {destinations.map((d) => {
        const Icon = destIcon[d.id];
        const count = d.id === "home" ? (view ? needsCount(view) : 0) : 0;
        const subs = subPages(page);
        return (
          <div key={d.id}>
            <a
              href={hashes.page(d.pages[0]!)}
              aria-current={dest === d.id ? "page" : undefined}
              className={cn("flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-tx2", dest === d.id && "bg-panel font-semibold text-fg shadow-[0_1px_2px_rgba(0,0,0,.06)]")}
            >
              <Icon className="size-[18px]" aria-hidden />
              <span className="min-w-0 flex-1">{d.label}</span>
              {count > 0 && <span aria-label={`${count} te necesitan`} className="rounded-full bg-need-bg px-[7px] text-[11.5px] leading-[18px] font-bold text-need">{count}</span>}
            </a>
            {dest === d.id && subs.length > 0 && (
              <div className="mt-0.5 mb-1 ml-[30px] flex flex-col border-l border-[#dcd9d1]">
                {subs.map((p) => (
                  <a key={p} href={hashes.page(p)} aria-current={p === page ? "page" : undefined} className={cn("rounded-md px-2.5 py-1 text-[12.5px] text-muted-fg", p === page && "font-semibold text-fg")}>
                    {pages[p].label}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {view && view.machines.length > 0 && (
        <section aria-label="Máquinas" className="mt-2">
          <h2 className="px-2.5 pt-3.5 pb-1 text-[11px] font-normal tracking-[.06em] text-muted-fg uppercase">Máquinas</h2>
          {view.machines.map((m) => (
            <a key={m.id} href={hashes.page("fleet")} className="flex items-center gap-2 px-2.5 py-1 text-[12.5px] text-tx2">
              <StatusDot status={m.link.status} />
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              <span className="shrink-0 text-muted-fg">{m.link.status === "online" ? `${m.running} en curso` : "sin conexión"}</span>
            </a>
          ))}
        </section>
      )}
      <button type="button" onClick={onHelp} className="mt-auto flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-muted-fg">
        <Keyboard className="size-4" aria-hidden />Atajos de teclado <kbd className="ml-auto">?</kbd>
      </button>
    </nav>
  );
}

/** Page header: title, description and sub-tabs (the screens never draw these), plus search and notifications. */
function TopBar({ page, onSearch }: { page: Page; onSearch: () => void }) {
  const subs = subPages(page);
  const { title, description } = pages[page];
  const actions = (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onSearch} aria-label="Buscar" className="grid size-10 place-items-center rounded-[9px] border border-line bg-panel text-muted-fg md:h-[34px] md:w-[280px] md:grid-cols-[auto_1fr_auto] md:gap-2 md:px-2.5 md:text-[13px]">
        <Search className="size-4" aria-hidden />
        <span className="hidden text-left md:block">Buscar en todo</span>
        <kbd className="hidden md:block">/</kbd>
      </button>
      <a href={hashes.page("notifications")} aria-label="Notificaciones" className="grid size-10 place-items-center rounded-[9px] border border-line bg-panel text-tx2 md:size-[34px]">
        <Bell className="size-[18px]" aria-hidden />
      </a>
    </div>
  );
  if (page === "project")
    return (
      <header className="flex items-center gap-3 px-4 pt-[max(.875rem,env(safe-area-inset-top))] pb-2 md:px-6 md:pt-4">
        <a href={hashes.page("projects")} className="inline-flex min-h-10 flex-1 items-center gap-1 text-sm text-primary md:min-h-0">‹ Proyectos</a>
        {actions}
      </header>
    );
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-[max(.875rem,env(safe-area-inset-top))] pb-2 md:px-6 md:pt-4 md:pb-3">
      <Logo className="md:hidden" />
      <div className="min-w-0 flex-auto">
        <h1 className="text-xl">{title}</h1>
        {(page === "home" || description) && <p className="hidden text-[13px] text-muted-fg md:block">{page === "home" ? today() : description}</p>}
      </div>
      {subs.length > 0 && (
        <Tabs
          label={title}
          className="order-last md:order-none"
          value={page}
          items={subs.map((p) => ({ id: p, label: pages[p].label, href: hashes.page(p) }))}
        />
      )}
      {actions}
    </header>
  );
}

/** Phone bottom bar: Hoy, Trabajo, the mic button (opens Pedir and starts dictation), Proyectos, Más. */
function TabBar({ page, view, onDictate }: { page: Page; view: HomeView | null; onDictate: () => void }) {
  const active = phoneTab(page);
  const needs = view ? needsCount(view) : 0;
  const tab = (id: "home" | "work" | "projects" | "more", label: string, Icon: ComponentType<{ className?: string }>, href: string) => (
    <a key={id} href={href} aria-current={active === id ? "page" : undefined} className={cn("relative flex min-w-0 flex-1 flex-col items-center gap-[3px] px-1 pt-2 pb-1.5 text-[10.5px] text-muted-fg", active === id && "text-primary")}>
      <Icon className="size-5" aria-hidden />
      {label}
      {id === "home" && needs > 0 && <span aria-label={`${needs} te necesitan`} className="absolute top-0.5 right-[calc(50%-22px)] grid h-4 min-w-4 place-items-center rounded-full bg-need px-1 text-[10px] leading-none font-bold text-white">{needs}</span>}
    </a>
  );
  return (
    <nav aria-label="Secciones" className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-panel px-1 pb-[max(.5rem,env(safe-area-inset-bottom))] md:hidden">
      {tab("home", "Hoy", House, hashes.page("home"))}
      {tab("work", "Trabajo", GitBranch, hashes.page("work"))}
      <div className="flex flex-1 justify-center">
        <button type="button" onClick={onDictate} aria-label="Dictar un pedido" className="-mt-[18px] grid size-12 place-items-center rounded-2xl bg-primary text-primary-fg shadow-[0_6px_16px_rgba(37,99,235,.35)] active:opacity-90">
          <Mic className="size-5" aria-hidden />
        </button>
      </div>
      {tab("projects", "Proyectos", Folder, hashes.page("projects"))}
      {tab("more", "Más", Ellipsis, hashes.page("more"))}
    </nav>
  );
}

/** Más: what the bottom bar has no room for. */
export function More({ view }: { view: HomeView | null }) {
  const machines = view?.machines ?? [];
  const offline = machines.filter((m) => m.link.status !== "online").length;
  const items: { page: Page; label: string; sub: string; icon: ComponentType<{ className?: string }> }[] = [
    { page: "money", label: "Dinero", sub: "Ingresos, costos y clientes", icon: Wallet },
    { page: "fleet", label: "Flota", sub: machines.length ? `${machines.length} ${machines.length === 1 ? "máquina" : "máquinas"}${offline ? ` · ${offline} sin conexión` : ""}` : "Máquinas e infraestructura", icon: Server },
    { page: "agents", label: "Agentes", sub: "Perfiles y acceso API", icon: Sparkles },
    { page: "notifications", label: "Notificaciones", sub: "Avisos en este dispositivo", icon: Bell },
    { page: "artifacts", label: "Artefactos", sub: "Lo que produjo tu trabajo", icon: FileText },
    { page: "memory", label: "Memoria", sub: "Lo que guardaron los agentes y vos", icon: Brain },
  ];
  return (
    <nav aria-label="Más" className="grid max-w-xl gap-3">
      <div className="divide-y divide-soft overflow-hidden rounded-card border border-line bg-panel">
        {items.map(({ page, label, sub, icon: Icon }) => (
          <a key={page} href={hashes.page(page)} className="flex items-center gap-3 px-3 py-3 active:bg-soft">
            <span className="grid size-9 place-items-center rounded-[10px] bg-soft text-tx2"><Icon className="size-[18px]" aria-hidden /></span>
            <span className="min-w-0 flex-1"><span className="block font-semibold">{label}</span><span className="block truncate text-[12.5px] text-muted-fg">{sub}</span></span>
            <ChevronRight className="size-4 text-muted-fg" aria-hidden />
          </a>
        ))}
      </div>
      <button
        type="button"
        onClick={() => void call("POST /api/logout").finally(connect)}
        className="flex items-center gap-3 rounded-card border border-line bg-panel px-3 py-3 text-left text-fail active:bg-fail-bg"
      >
        <LogOut className="size-[18px]" aria-hidden />Cerrar sesión
      </button>
    </nav>
  );
}

/** Keyboard cheat sheet. A native <dialog>, so focus is trapped and Escape closes it. */
export function KeyboardHelp({ onClose }: { onClose: () => void }) {
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
  const nameOf = (route: string) => {
    if (route === "ask") return "Pedir";
    const p = (Object.keys(pages) as Page[]).find((k) => pages[k].hash === route);
    return p ? pageName(p) : route;
  };
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
        <h2 id="shortcut-title" className="text-lg font-semibold">Atajos de teclado</h2>
        <button type="button" autoFocus onClick={onClose} className="rounded-lg border border-line px-3 py-2">Cerrar</button>
      </div>
      <p id="shortcut-description" className="mb-4 text-sm text-muted-fg">Apretá g y después la tecla de destino, dentro de 1,5 segundos. Los atajos se pausan mientras escribís o hay un diálogo abierto.</p>
      <dl className="space-y-2 text-sm">
        {Object.entries(navigationKeys).map(([key, route]) => (
          <div key={key} className="flex justify-between gap-4">
            <dt>Ir a {nameOf(route)}</dt>
            <dd><kbd>g</kbd> <kbd>{key}</kbd></dd>
          </div>
        ))}
        <div className="flex justify-between gap-4"><dt>Pedir a un agente</dt><dd><kbd>{askHint}</kbd></dd></div>
        <div className="flex justify-between gap-4"><dt>Buscar</dt><dd><kbd>/</kbd></dd></div>
        <div className="flex justify-between gap-4"><dt>Mostrar atajos</dt><dd><kbd>?</kbd></dd></div>
        <div className="flex justify-between gap-4"><dt>Cerrar</dt><dd><kbd>Esc</kbd></dd></div>
      </dl>
    </dialog>
  );
}

/** The frame every page renders in. Overlays (Pedir, Buscar, ThreadSheet) are mounted by App on top of it. */
export function Shell({ page, view, onAsk, onSearch, onHelp, children }: { page: Page; view: HomeView | null; onAsk: (dictate: boolean) => void; onSearch: () => void; onHelp: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <a href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }} className="skip-link">Saltar al contenido</a>
      <Sidebar page={page} view={view} onAsk={() => onAsk(false)} onHelp={onHelp} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar page={page} onSearch={onSearch} />
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-2 pb-28 outline-none md:px-6 md:pb-8">{children}</main>
      </div>
      <TabBar page={page} view={view} onDictate={() => onAsk(true)} />
    </div>
  );
}
