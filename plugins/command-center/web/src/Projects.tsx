import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pin, PinOff, Plus, Settings2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { MachineProjects } from "../../server/types.ts";
import { moveProject, type ProjectSettings, type ProjectSort } from "../../server/settings.ts";
import { call, useLive } from "./api.ts";
import { projectColor, statusTone, type Tone } from "./look.ts";
import { hashes, type ProjectTab } from "./navigation.ts";
import { ProjectDetail } from "./ProjectDetail.tsx";
import { ProjectDiscoveryPanel } from "./ProjectDiscovery.tsx";
import { projectDirectory, projectEntries, type ProjectEntry, type ProjectFilters } from "./projectDirectory.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Chip } from "./ui/Chip.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Card, EmptyState, Input, Select } from "./ui/fields.tsx";
import { Pager } from "./ui/Pager.tsx";
import { ProjectDot } from "./ui/ProjectDot.tsx";

const sorts: [ProjectSort, string][] = [
  ["activity", "Actividad reciente"],
  ["attention", "Los que te necesitan primero"],
  ["name", "Nombre"],
  ["manual", "Orden manual"],
];

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/** A number in a status colour; the words live in the label for hover and screen readers. */
function Count({ n, tone, label }: { n: number; tone: Tone; label: string }) {
  return (
    <span role="img" aria-label={`${n} ${label}`} title={`${n} ${label}`}>
      <Chip tone={tone} className="min-w-[22px] justify-center">{n}</Chip>
    </span>
  );
}

/** Proyectos / Todos (projectKey null) and the project detail (#project/<key>). */
export function Projects({ projectKey, tab }: { projectKey: string | null; tab: ProjectTab }) {
  const { view } = useLive();
  const [machines, setMachines] = useState<MachineProjects[] | null>(null);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [newGroup, setNewGroup] = useState("");
  const [filters, setFilters] = useState<ProjectFilters>({ query: "", machineId: "", status: "all" });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const filter = (patch: Partial<ProjectFilters>) => {
    setFilters((value) => ({ ...value, ...patch }));
    setPage(1);
  };

  useEffect(() => {
    call("GET /api/projects").then(setMachines, (e) => setError(message(e, "No se pudo cargar la lista de proyectos")));
    call("GET /api/settings/projects").then(setSettings, (e) => setError(message(e, "No se pudo cargar los ajustes de proyectos")));
  }, []);

  /** Optimistic: show the change now, store it, then show what the server kept. */
  const save = (patch: Partial<ProjectSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    call("PUT /api/settings/projects", { body: next }).then(setSettings, (e) => {
      setError(message(e, "No se pudo guardar"));
      call("GET /api/settings/projects").then(setSettings, () => {});
    });
  };

  const entries = useMemo<ProjectEntry[]>(() => projectEntries(machines ?? [], view), [machines, view]);

  const directory = settings ? projectDirectory(entries, settings, filters, page, size) : null;
  const currentPage = directory?.pagination.page ?? 1;
  useEffect(() => {
    setPage(currentPage);
  }, [currentPage]);

  if (!settings || !machines || !directory) return error ? <p role="alert" className="text-fail">{error}</p> : <p className="text-muted-fg">Cargando…</p>;

  const pinned = new Set(settings.pinned);
  const togglePin = (key: string) => save({ pinned: pinned.has(key) ? settings.pinned.filter((k) => k !== key) : [...settings.pinned, key] });

  if (projectKey !== null) {
    const entry = entries.find((e) => e.key === projectKey);
    if (!entry)
      return (
        <EmptyState action={<LinkButton href={hashes.page("projects")}>Volver a Proyectos</LinkButton>}>No se encontró el proyecto. Puede que su máquina esté desconectada.</EmptyState>
      );
    return <ProjectDetail entry={entry} tab={tab} view={view} pinned={pinned.has(entry.key)} onTogglePin={() => togglePin(entry.key)} />;
  }

  const { buckets, pagination, matchingTotal, canMove, inGroup } = directory;
  const setGroup = (key: string, gid: string) => {
    const groupOf = { ...settings.groupOf };
    if (gid) groupOf[key] = gid;
    else delete groupOf[key];
    save({ groupOf });
  };
  const toggleCollapsed = (id: string) => {
    setPage(1);
    save({ collapsed: settings.collapsed.includes(id) ? settings.collapsed.filter((c) => c !== id) : [...settings.collapsed, id] });
  };
  const addGroup = () => {
    const name = newGroup.trim();
    if (!name || settings.groups.some((g) => g.name.toLowerCase() === name.toLowerCase())) return;
    save({ groups: [...settings.groups, { id: crypto.randomUUID(), name }] });
    setNewGroup("");
  };
  const renameGroup = (id: string, name: string) => {
    const n = name.trim();
    if (n && n !== settings.groups.find((g) => g.id === id)?.name) save({ groups: settings.groups.map((g) => (g.id === id ? { ...g, name: n } : g)) });
  };
  // Deleting a group only ungroups its projects; the server drops their dangling entries.
  const removeGroup = (id: string) => save({ groups: settings.groups.filter((g) => g.id !== id) });
  const move = (items: ProjectEntry[], key: string, dir: -1 | 1) =>
    save({ order: moveProject(settings.order, items.map((e) => e.key), key, dir) });

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <Input className="col-span-2 md:max-w-xs md:flex-1" type="search" aria-label="Buscar proyectos" placeholder="Buscar por nombre o ruta…" value={filters.query} onChange={(e) => filter({ query: e.target.value })} />
        <Select className="md:w-auto" aria-label="Filtrar proyectos por máquina" value={filters.machineId} onChange={(e) => filter({ machineId: e.target.value })}>
          <option value="">Todas las máquinas</option>
          {machines.map((m) => <option key={m.machineId} value={m.machineId}>{m.machineLabel}</option>)}
        </Select>
        <Select className="md:w-auto" aria-label="Filtrar proyectos por estado" value={filters.status} onChange={(e) => filter({ status: e.target.value as ProjectFilters["status"] })}>
          <option value="all">Todos los estados</option><option value="online">En línea</option><option value="offline">Sin conexión</option>
        </Select>
        <Select className="md:w-auto" aria-label="Orden de los proyectos" value={settings.sort} onChange={(e) => { setPage(1); save({ sort: e.target.value as ProjectSort }); }}>
          {sorts.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <Select className="md:w-auto" aria-label="Proyectos por página" value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }}>
          {[10, 20, 50].map((n) => <option key={n} value={n}>{n} por página</option>)}
        </Select>
        <span className="hidden flex-1 md:block" />
        <Button variant={managing ? "primary" : "outline"} aria-pressed={managing} onClick={() => setManaging(!managing)}>
          <Settings2 className="size-4" aria-hidden /> Grupos
        </Button>
      </div>
      <p className="text-xs text-muted-fg">
        {matchingTotal} de {entries.length} proyectos coinciden; se muestran {pagination.items.length} ({pagination.start}–{pagination.end} de {pagination.total} en grupos abiertos)
      </p>
      {error && <p role="alert" className="text-fail">{error}</p>}
      <ProjectDiscoveryPanel machines={machines} />

      {managing && (
        <Card className="grid gap-2">
          {settings.groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2">
              <Input key={g.name} aria-label={`Nombre de ${g.name}`} maxLength={40} defaultValue={g.name} onBlur={(e) => renameGroup(g.id, e.target.value)} />
              <Button variant="ghost" size="icon" aria-label={`Eliminar ${g.name}; sus proyectos se conservan`} onClick={() => removeGroup(g.id)}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          {settings.groups.length < 50 && (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                addGroup();
              }}
            >
              <Input aria-label="Nombre del grupo nuevo" placeholder="Grupo nuevo…" maxLength={40} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
              <Button variant="outline" size="icon" type="submit" aria-label="Agregar grupo" disabled={!newGroup.trim()}>
                <Plus className="size-4" aria-hidden />
              </Button>
            </form>
          )}
          <p className="text-xs text-muted-fg">Asigná el grupo y el orden desde cada proyecto. Para reordenar elige el orden manual.</p>
        </Card>
      )}

      {entries.length === 0 && <EmptyState>Todavía no hay proyectos. Aparecen cuando se conecta una máquina.</EmptyState>}
      {entries.length > 0 && matchingTotal === 0 && <EmptyState>Ningún proyecto coincide con estos filtros.</EmptyState>}
      {buckets.map((b) => {
        const collapsed = b.collapsed;
        const Chevron = collapsed ? ChevronRight : ChevronDown;
        return (
          <section key={b.id} className="grid gap-2">
            <button
              type="button"
              className="flex items-center gap-1 text-left text-xs font-semibold tracking-wide text-muted-fg uppercase"
              disabled={b.groupId === null}
              aria-expanded={b.groupId === null ? undefined : !collapsed}
              onClick={() => b.groupId && toggleCollapsed(b.groupId)}
            >
              {b.groupId !== null && <Chevron className="size-4" aria-hidden />}
              {b.title}
              <span className="font-normal normal-case tabular-nums">{b.matchingCount} de {b.items.length}</span>
            </button>
            {!collapsed && b.rows.length > 0 && (
              <div className="divide-y divide-soft overflow-hidden rounded-card border border-line bg-panel md:grid md:grid-cols-2 md:gap-3 md:divide-y-0 md:overflow-visible md:border-0 md:bg-transparent xl:grid-cols-3">
                {b.rows.map(({ entry: e, index: i }) => {
                  const online = e.machine.status === "online";
                  const isPinned = pinned.has(e.key);
                  const open = e.needs + e.running + e.queued;
                  return (
                    <div
                      key={e.key}
                      style={{ "--pc": projectColor(e.key) } as CSSProperties}
                      className={cn(
                        "relative grid content-start gap-1.5 px-4 py-3 md:rounded-card md:border md:border-l-4 md:border-line md:border-l-[color:var(--pc)] md:bg-panel",
                        !online && "opacity-70",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <ProjectDot projectKey={e.key} className="md:hidden" />
                        <a href={hashes.project(e.key)} className="min-w-0 flex-1 truncate font-semibold after:absolute after:inset-0 after:content-['']">
                          {e.title}
                        </a>
                        <Button className="relative -my-2 -mr-2" variant="ghost" size="icon" aria-pressed={isPinned} aria-label={isPinned ? `Desfijar ${e.title}` : `Fijar ${e.title}`} onClick={() => togglePin(e.key)}>
                          {isPinned ? <PinOff className="size-4 text-primary" aria-hidden /> : <Pin className="size-4" aria-hidden />}
                        </Button>
                      </div>
                      <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-fg">
                        <StatusDot status={e.machine.status} />
                        <span className="truncate">
                          {e.machine.machineLabel}
                          {!online && ` · ${statusTone(e.machine.status).label}`}
                        </span>
                        <span className="ml-auto shrink-0">{ago(e.active)}</span>
                      </p>
                      <p className="hidden truncate text-xs text-muted-fg md:block" title={e.path}>{e.path}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {e.needs > 0 && <Count n={e.needs} tone="need" label={e.needs === 1 ? "te necesita" : "te necesitan"} />}
                        {e.running > 0 && <Count n={e.running} tone="run" label="en curso" />}
                        {e.queued > 0 && <Count n={e.queued} tone="queue" label="en cola" />}
                        {open === 0 && <span className="text-xs text-muted-fg">Sin trabajo abierto</span>}
                      </div>
                      {managing && (
                        <div className="relative flex flex-wrap items-center gap-1 border-t border-soft pt-2">
                          <Select className="h-9 w-auto max-w-40 flex-1 py-1 md:h-[26px] md:text-xs" aria-label={`Grupo de ${e.title}`} value={inGroup(e) ?? ""} onChange={(ev) => setGroup(e.key, ev.target.value)}>
                            <option value="">Sin grupo</option>
                            {settings.groups.map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                          </Select>
                          {canMove && (
                            <>
                              <Button variant="ghost" size="icon" aria-label={`Subir ${e.title}`} disabled={i === 0} onClick={() => move(b.items, e.key, -1)}>
                                <ArrowUp className="size-4" aria-hidden />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label={`Bajar ${e.title}`} disabled={i === b.items.length - 1} onClick={() => move(b.items, e.key, 1)}>
                                <ArrowDown className="size-4" aria-hidden />
                              </Button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      <Pager page={pagination} onPageChange={setPage} label="Proyectos" />
    </div>
  );
}
