import { ChevronLeft, ChevronRight, Ellipsis, GitBranch, House, ListTodo, Send } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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

const tabs = [
  { route: "home", label: "Home", icon: House },
  { route: "ask", label: "Ask", icon: Send },
  { route: "queue", label: "Queue", icon: ListTodo },
  { route: "work", label: "Work", icon: GitBranch },
  { route: "more", label: "More", icon: Ellipsis },
] as const;

// Pages under More; their hashes (#projects, #memory, ...) are handled here, not in api.ts.
const more = [
  { route: "projects", label: "Projects", page: Projects },
  { route: "memory", label: "Memory", page: Memory },
  { route: "sections", label: "Sections", page: Sections },
  { route: "profiles", label: "Profiles", page: Profiles },
  { route: "finance", label: "Finance", page: Finance },
  { route: "workflows", label: "Workflows", page: Workflows },
  { route: "artifacts", label: "Artifacts", page: Artifacts },
  { route: "infra", label: "Infra", page: Infra },
  { route: "orca", label: "Orca", page: Orca },
  { route: "machines", label: "Machines", page: Machines },
  { route: "agents", label: "Agents", page: Agents },
  { route: "notifications", label: "Notifications", page: Notifications },
] as const;

function More({ orca }: { orca: boolean }) {
  return (
    <nav aria-label="More" className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {more.filter((s) => orca || s.route !== "orca").map(({ route, label }) => (
        <a key={route} href={"#" + route} className="flex items-center justify-between px-4 py-3 text-sm">
          {label}
          <ChevronRight className="size-4 text-muted-fg" aria-hidden />
        </a>
      ))}
    </nav>
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
  useEffect(connect, []);
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
  const current = sub?.route ?? (runId ? "workflows" : active);
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
        <span className="flex-1">{label}</span>
        {n > 0 && <span className="min-w-5 rounded-full bg-warn px-1.5 text-center text-xs leading-5 text-bg">{n}</span>}
      </a>
    );
  };

  return (
    <div className="flex min-h-dvh">
      <nav aria-label="Pages" className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-3 lg:flex">
        <span className="px-3 pt-1 pb-3 font-semibold">Command Center</span>
        {tabs.filter((t) => t.route !== "more").map((t) => sideLink(t.route, t.label, t.icon))}
        <span className="mt-4 px-3 pb-1 text-xs text-muted-fg">More</span>
        {more.filter((s) => orca || s.route !== "orca").map((s) => sideLink(s.route, s.label))}
      </nav>
      <div className="mx-auto flex min-w-0 max-w-xl flex-1 flex-col lg:max-w-6xl">
      <main className="flex-1 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-24 lg:px-8 lg:pt-6 lg:pb-8">{page}</main>
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
    </div>
  );
}
