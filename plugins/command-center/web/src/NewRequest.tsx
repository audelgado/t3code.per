import { useEffect, useRef, useState } from "react";
import type { MachineProjects, RuntimeMode } from "../../server/types.ts";
import { call, refresh } from "./api.ts";
import { DictationTextarea } from "./DictationTextarea.tsx";
import { useChatDraft } from "./chatDraftState.ts";
import { hashes } from "./navigation.ts";
import { splitProjectKey } from "./projectDirectory.ts";
import { Button } from "./ui/Button.tsx";
import { Input, Select } from "./ui/fields.tsx";
import { Sheet } from "./ui/Sheet.tsx";

/** Choose a destination, then talk. Configuration is secondary to the request. */
export function NewRequest({ project, autoDictate, onClose }: { project: string | null; autoDictate: boolean; onClose: () => void }) {
  const [groups, setGroups] = useState<MachineProjects[]>([]);
  const [key, setKey] = useState(project ?? "");
  const [query, setQuery] = useState("");
  const [text, setText, clearSent] = useChatDraft(`project-request:${key}`);
  const [loading, setLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [mode, setMode] = useState<RuntimeMode>("full-access");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const command = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  useEffect(() => { let live = true; call("GET /api/projects").then((rows) => { if (live) setGroups(rows); }, (e) => { if (live) setProjectsError(e.message); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  const selected = groups.flatMap((g) => g.projects.map((p) => ({ key: `${g.machineId}:${p.id}`, title: p.title, machine: g.machineLabel }))).find((p) => p.key === key);
  const projectCount = groups.reduce((n, g) => n + g.projects.length, 0);
  const matches = groups.some((g) => g.projects.some((p) => `${p.title} ${g.machineLabel}`.toLowerCase().includes(query.toLowerCase())));
  return <Sheet title={key ? "¿Qué quieres hacer?" : "Elige un proyecto"} onClose={onClose} footer={<div className="flex items-center gap-2">{key ? <Button disabled={busy || listening} onClick={() => setKey("")}>Cambiar proyecto</Button> : <Button onClick={onClose}>Cancelar</Button>}{key && <Button className="ml-auto" variant="primary" type="submit" form="new-request" disabled={busy || listening || !text.trim() || !selected}>{busy ? "Enviando…" : "Enviar al chat"}</Button>}</div>}>
    {projectsError && <p role="alert" className="mb-3 text-sm text-fail">No se pudieron cargar los proyectos. {projectsError}</p>}
    {error && <p role="alert" className="mb-3 text-sm text-fail">{error}</p>}
    {!key ? <div className="grid gap-3"><Input type="search" aria-label="Buscar proyecto para el pedido" placeholder="Busca tu proyecto…" value={query} onChange={(e) => setQuery(e.target.value)} /><div className="max-h-[48dvh] overflow-y-auto">{groups.map((g) => {
      const projects = g.projects.filter((p) => `${p.title} ${g.machineLabel}`.toLowerCase().includes(query.toLowerCase()));
      return projects.length ? <section key={g.machineId} className="mb-3"><h3 className="mb-1 text-xs text-muted-fg">{g.machineLabel}{g.status !== "online" ? " · Sin conexión" : ""}</h3>{projects.map((p) => <button key={p.id} type="button" className="block w-full rounded-ctl px-3 py-3 text-left text-sm hover:bg-soft" onClick={() => setKey(`${g.machineId}:${p.id}`)}>{p.title}</button>)}</section> : null;
    })}{loading && <p role="status" className="text-sm text-muted-fg">Cargando proyectos…</p>}{!loading && !projectsError && !matches && <p role="status" className="text-sm text-muted-fg">{projectCount ? "No hay proyectos que coincidan con tu búsqueda." : "No hay proyectos disponibles. Agrega un proyecto desde T3 para comenzar."}</p>}</div></div> : <form id="new-request" className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (inFlight.current || listening || !text.trim() || !selected) return; inFlight.current = true; setBusy(true); setError(null); const { machineId, projectId } = splitProjectKey(key); void call("POST /api/project-chat/:machine/:project", { params: { machine: machineId, project: projectId }, body: { text, commandId: command.current, runtimeMode: mode } }).then(() => { clearSent(); void refresh(); onClose(); location.hash = hashes.project(key, "chat"); }, (e) => setError(e.message)).finally(() => { inFlight.current = false; setBusy(false); }); }}>
      <p className="text-sm text-muted-fg">{selected ? `${selected.title} · ${selected.machine}` : loading ? "Cargando proyecto…" : "Este proyecto no está disponible. Elige otro proyecto."}</p>
      <DictationTextarea compact autoDictate={autoDictate} aria-label="Nuevo pedido" placeholder="Escribe o dicta tu pedido…" rows={3} value={text} maxLength={20000} disabled={busy} onValueChange={(v) => { setText(v); command.current = crypto.randomUUID(); }} onListeningChange={setListening} />
      <details className="text-sm"><summary className="cursor-pointer text-muted-fg">Ajustes de una conversación nueva</summary><label className="mt-3 grid gap-1 text-xs">Permisos<Select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as RuntimeMode)}><option value="approval-required">Solicitar aprobación</option><option value="auto-accept-edits">Aceptar ediciones</option><option value="full-access">Acceso completo</option></Select></label><p className="mt-2 text-xs text-muted-fg">Se usa el agente del proyecto. Si el chat ya existe, conserva sus ajustes.</p></details>
    </form>}
  </Sheet>;
}
