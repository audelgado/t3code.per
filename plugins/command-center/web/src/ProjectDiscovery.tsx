import { useState } from "react";
import type { DiscoveryResult } from "../../server/projectDiscovery.ts";
import type { MachineProjects } from "../../server/types.ts";
import { call } from "./api.ts";
import { hashes } from "./navigation.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Field, Input, Select } from "./ui/fields.tsx";

const samePath = (left: string, right: string) => {
  const normalize = (value: string) => /^[a-z]:[\\/]|^\\\\/i.test(value) ? value.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase() : value.replace(/\/$/, "");
  return normalize(left) === normalize(right);
};

export function ProjectDiscoveryPanel({ machines }: { machines: MachineProjects[] }) {
  const [machineId, setMachineId] = useState("");
  const [root, setRoot] = useState("");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [resultMachine, setResultMachine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setResult(null); setError(null); };
  async function inspect() {
    setBusy(true); reset();
    try {
      const next = await call("POST /api/project-discovery", { body: { machineId, root } });
      setResult(next); setResultMachine(machineId);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo revisar la carpeta"); }
    finally { setBusy(false); }
  }
  return <details className="rounded-card border border-line bg-panel p-3">
    <summary className="cursor-pointer font-semibold">Buscar proyectos en otras carpetas</summary>
    <div className="mt-3 grid min-w-0 gap-3">
      <p className="text-xs text-muted-fg">Elige una carpeta padre concreta. Revisamos hasta 40 subcarpetas directas, sin modificar archivos ni registrar proyectos automáticamente.</p>
      <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
        <Field label="Sistema"><Select value={machineId} disabled={busy} onChange={(event) => { setMachineId(event.target.value); reset(); }}><option value="">Elige un sistema</option>{machines.map((machine) => <option key={machine.machineId} value={machine.machineId} disabled={machine.status !== "online"}>{machine.machineLabel}{machine.status !== "online" ? " · sin conexión" : ""}</option>)}</Select></Field>
        <Field label="Carpeta padre (ruta absoluta)"><Input value={root} maxLength={500} disabled={busy} onChange={(event) => { setRoot(event.target.value); reset(); }} placeholder="Pega la ruta de la carpeta que quieres revisar…" /></Field>
        <Button type="submit" disabled={busy || !machineId || !root.trim()} className="justify-self-start">{busy ? "Revisando carpeta…" : "Revisar carpeta"}</Button>
      </form>
      {error && <p role="alert" className="text-fail">{error}</p>}
      {result && <div className="grid gap-3" aria-live="polite">
        {!result.projects.length && <p>No encontramos proyectos con git o un manifiesto en las subcarpetas revisadas.</p>}
        {result.projects.map((project) => {
          const known = machines.find((machine) => machine.machineId === resultMachine)?.projects.find((candidate) => samePath(candidate.workspaceRoot, project.path));
          return <div key={project.path} className="grid min-w-0 gap-1 border-t border-soft pt-3">
            <strong>{project.title}</strong><p className="break-all text-xs text-muted-fg">{project.path}</p>
            <p className="break-words text-xs text-muted-fg">Evidencia: {project.evidence.join(", ")}</p>
            {project.registered ? known ? <LinkButton className="justify-self-start" size="sm" href={hashes.project(`${resultMachine}:${known.id}`, "plan")}>Ver plan y pendientes</LinkButton> : <p>Registrado en T3. Actualiza la lista para abrirlo.</p> : <p className="text-sm">No registrado en T3. Regístralo en T3 de este sistema y después abre su plan en el CC.</p>}
          </div>;
        })}
        {result.hasMore && <p className="text-xs text-muted-fg">Hay más de 40 subcarpetas. Elige una carpeta padre más específica para continuar.</p>}
        {result.errors.map((item) => <p key={item.path} className="break-words text-xs text-fail">{item.path}: {item.message}</p>)}
      </div>}
    </div>
  </details>;
}
