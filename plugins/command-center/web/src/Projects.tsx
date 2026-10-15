import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { MachineProjects } from "../../server/types.ts";
import { compareManual, moveProject, type ProjectSettings, type ProjectSort } from "../../server/settings.ts";
import { call, useLive } from "./api.ts";
import { StatusDot } from "./StatusDot.tsx";
import { Button, LinkButton } from "./ui/Button.tsx";
import { ago, cn } from "./ui/cn.ts";
import { Badge, Card, Empty, Input, Select } from "./ui/fields.tsx";

const sorts: [ProjectSort, string][] = [
  ["activity", "Recent activity"],
  ["attention", "Needs you first"],
  ["name", "Name"],
  ["manual", "Manual"],
];

interface Entry {
  key: string;
  machine: MachineProjects;
  title: string;
  running: number;
  needs: number;
  queued: number;
  /** Newest thread activity (ISO) or the project's own update time. */
  active: string;
}

export function Projects() {
  const { view } = useLive();
  const [machines, setMachines] = useState<MachineProjects[] | null>(null);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [newGroup, setNewGroup] = useState("");

  useEffect(() => {
    call("GET /api/projects").then(setMachines, (e) => setError(e instanceof Error ? e.message : "Could not load projects"));
    call("GET /api/settings/projects").then(setSettings, (e) => setError(e instanceof Error ? e.message : "Could not load settings"));
  }, []);

  /** Optimistic: show the change now, store it, then show what the server kept. */
  const save = (patch: Partial<ProjectSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    call("PUT /api/settings/projects", { body: next }).then(setSettings, (e) => {
      setError(e instanceof Error ? e.message : "Could not save");
      call("GET /api/settings/projects").then(setSettings, () => {});
    });
  };

  const entries = useMemo<Entry[]>(() => {
    const stat = new Map<string, { running: number; needs: number; queued: number; active: string }>();
    const bump = (key: string, f: (s: { running: number; needs: number; queued: number; active: string }) => void) => {
      const s = stat.get(key) ?? { running: 0, needs: 0, queued: 0, active: "" };
      f(s);
      stat.set(key, s);
    };
    const seen = (s: { active: string }, iso: string) => (s.active = iso > s.active ? iso : s.active);
    for (const t of view?.running ?? []) bump(`${t.machineId}:${t.projectId}`, (s) => (s.running++, seen(s, t.updatedAt)));
    for (const t of view?.done ?? []) bump(`${t.machineId}:${t.projectId}`, (s) => seen(s, t.updatedAt));
    for (const n of view?.needsYou ?? []) {
      const o = n.kind === "thread" ? n.thread : n.kind === "task_approval" ? n.task : null;
      if (o) bump(`${o.machineId}:${o.projectId}`, (s) => s.needs++);
    }
    for (const t of view?.queue ?? []) if (t.status === "queued") bump(`${t.machineId}:${t.projectId}`, (s) => s.queued++);
    return (machines ?? []).flatMap((m) =>
      m.projects.map((p) => {
        const key = `${m.machineId}:${p.id}`;
        const s = stat.get(key);
        return { key, machine: m, title: p.title, running: s?.running ?? 0, needs: s?.needs ?? 0, queued: s?.queued ?? 0, active: s?.active || p.updatedAt };
      }),
    );
  }, [machines, view]);

  if (!settings || !machines) return error ? <p className="text-bad">{error}</p> : <p className="text-muted-fg">Loading...</p>;

  const sort = (list: Entry[]) => {
    const by: Record<ProjectSort, (a: Entry, b: Entry) => number> = {
      activity: (a, b) => b.active.localeCompare(a.active),
      attention: (a, b) => b.needs - a.needs || b.running - a.running || b.active.localeCompare(a.active),
      name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
      manual: (() => {
        const m = compareManual(settings.order);
        return (a, b) => m(a.key, b.key);
      })(),
    };
    return list.toSorted((a, b) => by[settings.sort](a, b) || a.title.localeCompare(b.title));
  };

  const pinned = new Set(settings.pinned);
  const groupIds = new Set(settings.groups.map((g) => g.id));
  const inGroup = (e: Entry) => (groupIds.has(settings.groupOf[e.key] ?? "") ? settings.groupOf[e.key]! : null);
  const buckets: { id: string; title: string; groupId: string | null; items: Entry[] }[] = [
    { id: "pinned", title: "Pinned", groupId: null, items: sort(entries.filter((e) => pinned.has(e.key))) },
    ...settings.groups.map((g) => ({ id: g.id, title: g.name, groupId: g.id, items: sort(entries.filter((e) => !pinned.has(e.key) && inGroup(e) === g.id)) })),
    { id: "other", title: settings.groups.length ? "Other" : "Projects", groupId: null, items: sort(entries.filter((e) => !pinned.has(e.key) && inGroup(e) === null)) },
  ];

  const togglePin = (key: string) => save({ pinned: pinned.has(key) ? settings.pinned.filter((k) => k !== key) : [...settings.pinned, key] });
  const setGroup = (key: string, gid: string) => {
    const groupOf = { ...settings.groupOf };
    if (gid) groupOf[key] = gid;
    else delete groupOf[key];
    save({ groupOf });
  };
  const toggleCollapsed = (id: string) => save({ collapsed: settings.collapsed.includes(id) ? settings.collapsed.filter((c) => c !== id) : [...settings.collapsed, id] });
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
  const move = (items: Entry[], key: string, dir: -1 | 1) =>
    save({ order: moveProject(settings.order, items.map((e) => e.key), key, dir) });

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">Projects</h1>
        <Button variant={managing ? "primary" : "outline"} size="sm" onClick={() => setManaging(!managing)}>
          Groups
        </Button>
      </div>
      <Select aria-label="Sort projects" value={settings.sort} onChange={(e) => save({ sort: e.target.value as ProjectSort })}>
        {sorts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
      {error && <p className="text-bad">{error}</p>}

      {managing && (
        <Card className="grid gap-2">
          {settings.groups.map((g) => (
            <div key={g.id} className="flex items-center gap-2">
              <Input key={g.name} aria-label={`Name of ${g.name}`} maxLength={40} defaultValue={g.name} onBlur={(e) => renameGroup(g.id, e.target.value)} />
              <Button variant="ghost" size="icon" aria-label={`Delete ${g.name}; its projects stay`} onClick={() => removeGroup(g.id)}>
                <Trash2 className="size-4" />
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
              <Input aria-label="New group name" placeholder="New group" maxLength={40} value={newGroup} onChange={(e) => setNewGroup(e.target.value)} />
              <Button variant="outline" size="icon" type="submit" aria-label="Add group" disabled={!newGroup.trim()}>
                <Plus className="size-4" />
              </Button>
            </form>
          )}
        </Card>
      )}

      {entries.length === 0 && <Empty>No projects yet. They appear once a machine is connected.</Empty>}
      {buckets
        .filter((b) => b.items.length > 0 || (b.groupId && managing))
        .map((b) => {
          const collapsed = b.groupId !== null && settings.collapsed.includes(b.groupId);
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
                <span className="font-normal normal-case">{b.items.length}</span>
              </button>
              {!collapsed &&
                b.items.map((e, i) => (
                  <Card key={e.key} className={cn("grid gap-2", e.machine.status !== "online" && "opacity-70")}>
                    <div className="flex items-center gap-2">
                      <a href={`#ask?project=${encodeURIComponent(e.key)}`} className="flex min-w-0 flex-1 items-center gap-2">
                        <StatusDot status={e.machine.status} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{e.title}</span>
                          <span className="block truncate text-muted-fg">
                            {e.machine.machineLabel}
                            {e.machine.status !== "online" && ` · ${e.machine.status}`}
                            {e.active && ` · ${ago(e.active)}`}
                          </span>
                        </span>
                      </a>
                      <Button variant="ghost" size="icon" aria-pressed={pinned.has(e.key)} aria-label={pinned.has(e.key) ? `Unpin ${e.title}` : `Pin ${e.title}`} onClick={() => togglePin(e.key)}>
                        {pinned.has(e.key) ? <PinOff className="size-4" /> : <Pin className="size-4" />}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {e.needs > 0 && <Badge className="bg-warn/15 text-warn">{e.needs} need you</Badge>}
                      {e.running > 0 && <Badge>{e.running} running</Badge>}
                      {e.queued > 0 && <Badge>{e.queued} queued</Badge>}
                      <span className="flex-1" />
                      {settings.groups.length > 0 && (
                        <Select className="h-9 w-auto max-w-40 py-1" aria-label={`Group of ${e.title}`} value={inGroup(e) ?? ""} onChange={(ev) => setGroup(e.key, ev.target.value)}>
                          <option value="">No group</option>
                          {settings.groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </Select>
                      )}
                      {settings.sort === "manual" && (
                        <>
                          <Button variant="ghost" size="icon" aria-label={`Move ${e.title} up`} disabled={i === 0} onClick={() => move(b.items, e.key, -1)}>
                            <ArrowUp className="size-4" />
                          </Button>
                          <Button variant="ghost" size="icon" aria-label={`Move ${e.title} down`} disabled={i === b.items.length - 1} onClick={() => move(b.items, e.key, 1)}>
                            <ArrowDown className="size-4" />
                          </Button>
                        </>
                      )}
                      <LinkButton variant="outline" size="sm" href={`#ask?project=${encodeURIComponent(e.key)}`}>
                        Ask
                      </LinkButton>
                    </div>
                  </Card>
                ))}
            </section>
          );
        })}
    </div>
  );
}
