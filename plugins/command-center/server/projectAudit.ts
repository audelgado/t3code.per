import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getMachine, getProject } from "./db.ts";
import { HttpError, type Route } from "./http.ts";
import { ToolError, type ToolDef } from "./mcp.ts";
import { listArtifacts, saveArtifact, type ArtifactStore } from "./artifacts.ts";
import { createProjectReconciler, parseAuditReport } from "./projectReconcile.ts";
import { projectAuditWorkflow } from "./projectAuditWorkflow.ts";
import type { FileLink } from "./t3link.ts";
import type { ModelSelection, T3Link, TaskSource } from "./types.ts";
import type { createWorkflows } from "./workflows.ts";

export interface ProjectAudit {
  id: string;
  machineId: string;
  projectId: string;
  workflowRunId: string;
  reportPath: string;
  status: "running" | "needs_you" | "applied" | "failed" | "cancelled";
  questions: string[];
  summary: string | null;
  artifactId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectAuditInput {
  machineId: string;
  projectId: string;
  answers?: string;
  model?: ModelSelection;
}
declare module "./types.ts" {
  interface Api {
    "GET /api/project-audits": { body: never; res: ProjectAudit[] };
    "POST /api/project-audits": { body: ProjectAuditInput; res: ProjectAudit };
    "POST /api/project-audits/:id/retry": { body: never; res: ProjectAudit };
  }
}
export interface ProjectAuditDeps {
  db: DatabaseSync;
  workflows: Pick<ReturnType<typeof createWorkflows>, "save" | "start" | "detail">;
  link: (id: string) => (T3Link & Partial<FileLink>) | undefined;
  artifacts: ArtifactStore;
  onChange?: () => void;
}

/** Runs the existing queue's research/review team and imports its run-scoped file without exposing CC credentials. */
export function createProjectAudits(deps: ProjectAuditDeps) {
  const { db, workflows } = deps;
  const reconcile = createProjectReconciler(db);
  db.exec(`create table if not exists cc_project_audits(
    id text primary key, machine_id text not null, project_id text not null,
    workflow_run_id text not null, report_path text not null, status text not null,
    questions text not null default '[]', summary text, artifact_id text, error text,
    created_at text not null, updated_at text not null
  ); create index if not exists cc_project_audits_project on cc_project_audits(machine_id, project_id, created_at);`);
  const decode = (r: Record<string, unknown>): ProjectAudit => ({
    id: String(r.id), machineId: String(r.machine_id), projectId: String(r.project_id),
    workflowRunId: String(r.workflow_run_id), reportPath: String(r.report_path), status: r.status as ProjectAudit["status"],
    questions: JSON.parse(String(r.questions)), summary: r.summary as string | null,
    artifactId: r.artifact_id as string | null, error: r.error as string | null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  });
  const get = (id: string) => {
    const row = db.prepare("select * from cc_project_audits where id = ?").get(id);
    if (!row) throw new HttpError(404, "not_found", "Revisión no encontrada");
    return decode(row);
  };
  const list = (machineId: string, projectId: string) => db.prepare("select * from cc_project_audits where machine_id = ? and project_id = ? order by created_at desc, rowid desc limit 10").all(machineId, projectId).map(decode);
  const patch = (id: string, status: ProjectAudit["status"], error: string | null = null) => {
    db.prepare("update cc_project_audits set status = ?, error = ?, updated_at = ? where id = ?").run(status, error, new Date().toISOString(), id);
    deps.onChange?.();
  };
  async function start(input: ProjectAuditInput, source: TaskSource = "user") {
    if (!input || typeof input.machineId !== "string" || typeof input.projectId !== "string") throw new HttpError(400, "bad_request", "Elegí sistema y proyecto");
    const project = getProject(db, input.machineId, input.projectId);
    const machine = getMachine(db, input.machineId);
    if (!project || !machine?.enabled) throw new HttpError(400, "bad_request", "Proyecto no disponible");
    if (db.prepare("select count(*) as n from projects where project_id = ?").get(project.id)!.n !== 1) throw new HttpError(409, "conflict", "Este identificador de proyecto existe en varios sistemas; requiere separar su seguimiento");
    if (input.answers !== undefined && (typeof input.answers !== "string" || input.answers.length > 4000)) throw new HttpError(400, "bad_request", "Las aclaraciones deben tener hasta 4000 caracteres");
    const link = deps.link(machine.id);
    if (link?.state.status !== "online" || !link.readFile) throw new HttpError(409, "conflict", "El sistema debe estar en línea y permitir lectura de archivos");
    const available = (await link.providers()).filter((p) => p.enabled && p.installed);
    const selected = input.model ?? project.defaultModel ?? (() => {
      const p = available[0]; const m = p?.models.find((m) => m.isDefault) ?? p?.models[0];
      return p && m ? { instanceId: p.instanceId, model: m.slug } : undefined;
    })();
    if (!selected || !available.some((p) => p.instanceId === selected.instanceId && p.models.some((m) => m.slug === selected.model))) throw new HttpError(409, "conflict", "Elegí un modelo disponible en este sistema");
    const active = list(machine.id, project.id).find((r) => r.status === "running");
    if (active) return active;
    const id = randomUUID();
    const reportPath = `.t3/cc-audits/${id}/proposal.json`;
    // The engine takes a snapshot of this definition for each run. The library entry remains reusable.
    const existing = reconcile.snapshot(project.id);
    const context = { machineId: machine.id, machineLabel: machine.label, projectId: project.id, title: project.title, root: project.workspaceRoot, existing, omitted: { todos: 0, phases: 0, stableKeys: 0 } };
    // Leave room for the role instructions and answers under the engine's 20 KB prompt limit.
    while (JSON.stringify(context).length > 8500 && existing.todos.length) { existing.todos.pop(); context.omitted.todos++; }
    while (JSON.stringify(context).length > 8500 && existing.stableKeys.length) { existing.stableKeys.pop(); context.omitted.stableKeys++; }
    while (JSON.stringify(context).length > 8500 && existing.phases.length) { existing.phases.pop(); context.omitted.phases++; }
    const workflow = projectAuditWorkflow({ slug: "cc-project-audit", reportPath,
      context: JSON.stringify(context),
      answers: input.answers ?? "Sin aclaraciones adicionales. Conservá como preguntas las decisiones sin evidencia." });
    workflows.save(workflow, "user");
    const run = workflows.start({ slug: workflow.slug, machineId: machine.id, projectId: project.id, model: selected, runtimeMode: "full-access" }, source, true);
    const now = new Date().toISOString();
    db.prepare("insert into cc_project_audits(id,machine_id,project_id,workflow_run_id,report_path,status,created_at,updated_at) values(?,?,?,?,?,'running',?,?)").run(id, machine.id, project.id, run.run.id, reportPath, now, now);
    deps.onChange?.();
    return get(id);
  }
  const collecting = new Set<string>();
  async function collect(audit: ProjectAudit) {
    if (collecting.has(audit.id)) return;
    collecting.add(audit.id);
    try {
      const run = workflows.detail(audit.workflowRunId).run;
      if (run.status === "failed" || run.status === "cancelled") { patch(audit.id, run.status, run.error); return; }
      if (run.status !== "succeeded") return;
      const project = getProject(db, audit.machineId, audit.projectId);
      const link = deps.link(audit.machineId);
      if (!project || link?.state.status !== "online" || !link.readFile) return;
      const file = await link.readFile(project.workspaceRoot, audit.reportPath);
      if (file.truncated) throw new Error("El informe excede el límite de lectura; no se aplicó");
      const report = parseAuditReport(JSON.parse(file.contents));
      const title = `Revisión del proyecto · ${audit.id}`;
      const previous = listArtifacts(db, { projectId: project.id, query: audit.id, limit: 10 }).artifacts.find((a) => a.title === title);
      const artifact = previous ?? saveArtifact(deps.artifacts, { projectId: project.id, title, kind: "markdown", content: `# Revisión del proyecto\n\n${report.progress}\n\nRevisión: ${report.revision}\n\n## Evidencia\n${report.evidence.map((e) => `- ${e}`).join("\n")}\n\n## Informe completo\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`` }, "equipo-organizador").artifact;
      // Import a missing PRD only. Existing user versions remain authoritative.
      if (report.prdPath && !listArtifacts(db, { projectId: project.id, query: "PRD", archived: false, limit: 1 }).artifacts.length) {
        if (!/\.md$/i.test(report.prdPath) || /(^|\/)(?:\.[^/]*|secrets?|credentials?)(\/|$)/i.test(report.prdPath)) throw new Error("El PRD debe ser un Markdown del proyecto");
        const prd = await link.readFile(project.workspaceRoot, report.prdPath);
        if (prd.truncated) throw new Error("PRD truncado; no se importó");
        saveArtifact(deps.artifacts, { projectId: project.id, title: `PRD · ${project.title}`, kind: "markdown", content: prd.contents }, "equipo-organizador");
      }
      const applied = reconcile.apply({ id: audit.id, machineId: audit.machineId, projectId: audit.projectId, report });
      db.prepare("update cc_project_audits set status=?,questions=?,summary=?,artifact_id=?,error=null,updated_at=? where id=?").run(applied.questions.length ? "needs_you" : "applied", JSON.stringify(applied.questions), `${applied.addedPhases} fases y ${applied.addedTodos} pendientes agregados. Revisión ${report.revision}.`, artifact.id, new Date().toISOString(), audit.id);
      deps.onChange?.();
    } catch (e) { patch(audit.id, "failed", e instanceof Error ? e.message : "No se pudo validar el informe"); }
    finally { collecting.delete(audit.id); }
  }
  async function advance() {
    await Promise.all(db.prepare("select * from cc_project_audits where status = 'running'").all().map((r) => collect(decode(r))));
  }
  const routes: Route[] = [
    { method: "GET", path: "/api/project-audits", auth: "cookie", handler: ({ url }) => list(url.searchParams.get("machineId") ?? "", url.searchParams.get("projectId") ?? "") },
    { method: "POST", path: "/api/project-audits", auth: "cookie", handler: ({ body }) => start(body as ProjectAuditInput) },
    { method: "POST", path: "/api/project-audits/:id/retry", auth: "cookie", handler: async ({ params }) => {
      const audit = get(params.id!);
      if (audit.status !== "failed") throw new HttpError(409, "conflict", "Solo se reintenta la importación de una revisión fallida");
      if (workflows.detail(audit.workflowRunId).run.status !== "succeeded") throw new HttpError(409, "conflict", "Reanudá primero el flujo desde Trabajo → Flujos");
      patch(audit.id, "running"); await collect(get(audit.id)); return get(audit.id);
    } },
  ];
  const tools: ToolDef[] = [
    { name: "project_audit_start", description: "Propose an evidence-based project organization team run. The user approves agent-started work in Flows. CC imports the results without giving workers CC credentials.", inputSchema: { type: "object", properties: { machineId: { type: "string" }, projectId: { type: "string" }, answers: { type: "string", maxLength: 4000 } }, required: ["machineId", "projectId"] }, handler: async (args, agent) => {
      try { return await start({ machineId: String(args.machineId ?? ""), projectId: String(args.projectId ?? ""), answers: typeof args.answers === "string" ? args.answers : undefined }, `agent:${agent}`); }
      catch (e) { throw new ToolError(e instanceof Error ? e.message : "No se pudo iniciar la revisión"); }
    } },
    { name: "project_audit_status", description: "Read the latest project organization runs, applied results and unresolved questions.", inputSchema: { type: "object", properties: { machineId: { type: "string" }, projectId: { type: "string" } }, required: ["machineId", "projectId"] }, handler: (args) => list(String(args.machineId ?? ""), String(args.projectId ?? "")) },
  ];
  return { start, list, advance, routes, tools };
}
