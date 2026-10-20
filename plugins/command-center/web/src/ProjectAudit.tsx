import { useCallback, useEffect, useState } from "react";
import type { ProjectAudit } from "../../server/projectAudit.ts";
import type { ProviderInfo } from "../../server/types.ts";
import { call, useLive } from "./api.ts";
import { hashes } from "./navigation.ts";
import { splitProjectKey } from "./projectDirectory.ts";
import { Button, LinkButton } from "./ui/Button.tsx";
import { Panel } from "./ui/Panel.tsx";
import { Select } from "./ui/fields.tsx";
import { DictationTextarea } from "./DictationTextarea.tsx";
import { ago } from "./ui/cn.ts";

const labels: Record<ProjectAudit["status"], string> = { running: "Equipo trabajando", needs_you: "Faltan aclaraciones", applied: "Seguimiento actualizado", failed: "Revisión sin completar", cancelled: "Cancelada" };

/** On-demand team: its files are collected by the server; the browser never supplies credentials to agents. */
export function ProjectAuditPanel({ projectKey, onApplied }: { projectKey: string; onApplied: () => void }) {
  const { machineId, projectId } = splitProjectKey(projectKey);
  const { view } = useLive();
  const [audit, setAudit] = useState<ProjectAudit | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [model, setModel] = useState("");
  const [listening, setListening] = useState(false);
  const [answers, setAnswers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => call("GET /api/project-audits", { query: { machineId, projectId } }).then((rows) => { setAudit(rows[0] ?? null); }, (e) => setError(String(e.message))), [machineId, projectId]);
  useEffect(() => { let active = true; call("GET /api/machines/:id/providers", { params: { id: machineId } }).then((rows) => { if (active) setProviders(rows.filter((p) => p.installed && p.enabled)); }, () => {}); return () => { active = false; }; }, [machineId]);
  useEffect(() => { void load(); }, [load, view]);
  useEffect(() => { if (audit?.status !== "running") return; const timer = setTimeout(() => void load(), 5000); return () => clearTimeout(timer); }, [audit, load]);
  useEffect(() => { if (audit?.status === "applied" || audit?.status === "needs_you") onApplied(); }, [audit?.id, audit?.status]);
  const start = async () => {
    if (listening) return;
    setBusy(true); setError(null);
    try { setAudit(await call("POST /api/project-audits", { body: { machineId, projectId, answers: answers.trim() || undefined, model: model ? JSON.parse(model) : undefined } })); setAnswers(""); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo iniciar la revisión"); }
    finally { setBusy(false); }
  };
  return <Panel title="Organizar con equipo" action={audit ? <LinkButton size="sm" href={hashes.run(audit.workflowRunId)}>Ver ejecución</LinkButton> : undefined}>
    <div className="grid gap-3 px-4 py-3">
      <p className="text-sm text-muted-fg">Investiga los documentos y Git de este proyecto, contrasta la evidencia y agrega fases, pendientes y avance al CC. Conserva tus tareas y estados existentes. Cada revisión usa dos pasos de agentes y guarda su informe.</p>
      {audit && <div className="grid gap-1"><p className="font-semibold">{labels[audit.status]} · {ago(audit.updatedAt)}</p>{audit.summary && <p className="text-sm">{audit.summary}</p>}{audit.error && <p role="alert" className="text-fail">{audit.error}</p>}</div>}
      {audit?.questions.length ? <div className="grid gap-2"><details><summary className="cursor-pointer font-semibold">{audit.questions.length} decisiones por aclarar</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{audit.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></details><p className="text-xs text-muted-fg">El equipo actualizó lo comprobable. Puedes responder ahora y ejecutar otra revisión, o dejar estas decisiones pendientes.</p></div> : null}
      <DictationTextarea aria-label="Aclaraciones para el equipo" placeholder="Objetivo, prioridades o respuestas a las preguntas (opcional)…" maxLength={4000} value={answers} onValueChange={setAnswers} onListeningChange={setListening} disabled={busy || audit?.status === "running"} />
      <div className="flex flex-wrap gap-2">
        <Select className="min-w-0 flex-1" aria-label="Modelo del equipo organizador" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy || audit?.status === "running"}><option value="">Modelo del proyecto</option>{providers.flatMap((p) => p.models.map((m) => <option key={`${p.instanceId}:${m.slug}`} value={JSON.stringify({ instanceId: p.instanceId, model: m.slug })}>{p.displayName} · {m.name}</option>))}</Select>
        <Button variant="primary" disabled={busy || listening || audit?.status === "running"} onClick={() => void start()}>{busy ? "Iniciando…" : audit?.status === "running" ? "Equipo trabajando…" : answers.trim() ? "Revisar con aclaraciones" : "Revisar y organizar"}</Button>
      </div>
      {audit?.artifactId && <a className="text-sm text-primary" href={hashes.project(projectKey, "artifacts")}>Ver informe y evidencia en Artefactos</a>}
      {audit?.status === "failed" && <Button disabled={busy} onClick={async () => { setBusy(true); try { setAudit(await call("POST /api/project-audits/:id/retry", { params: { id: audit.id } })); } catch (e) { setError(e instanceof Error ? e.message : "No se pudo reintentar"); } finally { setBusy(false); } }}>Reintentar importación</Button>}
      {error && <p role="alert" className="text-fail">{error}</p>}
    </div>
  </Panel>;
}
