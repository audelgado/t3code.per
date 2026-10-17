import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { initMemory, listMemory, saveMemory } from "./memory.ts";
import { createSectionService, SECTION_STATUSES, type SectionStatus } from "./sections.ts";

export interface AuditReport {
  version: 1;
  revision: string;
  progress: string;
  evidence: string[];
  phases: { key: string; name: string; status: SectionStatus; summary: string; evidence: string[] }[];
  todos: { key: string; text: string; phaseKey?: string; evidence: string[] }[];
  questions: string[];
  prdPath?: string;
}

const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
};
const text = (value: unknown, label: string, max: number) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new Error(`${label} must be a non-empty string of at most ${max} characters`);
  return value.trim();
};
const array = (value: unknown, label: string, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must contain at most ${max} entries`);
  return value;
};
const key = (value: unknown) => {
  const result = text(value, "key", 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw new Error("Invalid stable key");
  return result;
};

/** Evidence is a repository-relative path (optionally with lines or an anchor) or a commit hash. */
function reference(value: unknown, fileOnly = false): string {
  const result = text(value, "evidence reference", 300);
  if (!fileOnly && /^(?:(?:commit|git):)?[0-9a-f]{7,64}$/i.test(result)) return result;
  let path = result;
  if (!fileOnly) {
    const hash = result.indexOf("#");
    if (hash >= 0) {
      const anchor = result.slice(hash + 1);
      if (!/^[\p{L}\p{N}_.-]{1,160}$/u.test(anchor)) throw new Error("Invalid evidence anchor");
      path = result.slice(0, hash);
    }
    path = path.replace(/:\d+(?:-\d+)?$/, "");
  }
  if (/^[\/~]/.test(path) || /[:\\\r\n?#]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("Evidence must reference a relative repository path or commit hash");
  return result;
}
const evidence = (value: unknown) => {
  const refs = array(value, "evidence", 10).map((v) => reference(v));
  if (!refs.length) throw new Error("Evidence is required for progress, phases and todos");
  return [...new Set(refs)];
};

export function parseAuditReport(raw: unknown): AuditReport {
  const input = obj(raw);
  if (input.version !== 1) throw new Error("Unsupported audit report version");
  const phases = array(input.phases, "phases", 20).map((rawPhase) => {
    const phase = obj(rawPhase);
    if (!SECTION_STATUSES.includes(phase.status as SectionStatus)) throw new Error("Invalid phase status");
    return { key: key(phase.key), name: text(phase.name, "phase name", 80), status: phase.status as SectionStatus,
      summary: text(phase.summary, "phase summary", 500), evidence: evidence(phase.evidence) };
  });
  const todos = array(input.todos, "todos", 60).map((rawTodo) => {
    const todo = obj(rawTodo);
    return { key: key(todo.key), text: text(todo.text, "todo text", 2000),
      ...(todo.phaseKey === undefined ? {} : { phaseKey: key(todo.phaseKey) }), evidence: evidence(todo.evidence) };
  });
  if (new Set(phases.map((p) => p.key)).size !== phases.length || new Set(todos.map((t) => t.key)).size !== todos.length)
    throw new Error("Stable keys must be unique within each kind");
  if (todos.some((t) => t.phaseKey && !phases.some((p) => p.key === t.phaseKey))) throw new Error("Unknown todo phaseKey");
  return { version: 1, revision: text(input.revision, "revision", 120), progress: text(input.progress, "progress", 4000),
    evidence: evidence(input.evidence), phases, todos,
    questions: array(input.questions, "questions", 10).map((q) => text(q, "question", 500)),
    ...(input.prdPath === undefined ? {} : { prdPath: reference(input.prdPath, true) }) };
}

const normalize = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
export interface ReconcileResult { addedPhases: number; addedTodos: number; progressId: string; questions: string[] }

/** Imports evidence-backed additions. Existing user records and completion states are never overwritten. */
export function createProjectReconciler(db: DatabaseSync) {
  initMemory(db);
  const sections = createSectionService(db);
  db.exec(`
    create table if not exists cc_project_audit_imports(
      id text primary key, machine_id text not null, project_id text not null,
      report_hash text not null, result text not null
    );
    create table if not exists cc_project_audit_keys(
      machine_id text not null, project_id text not null, kind text not null,
      stable_key text not null, entity_id text not null, original_text text not null,
      evidence text not null, revision text not null,
      primary key(machine_id, project_id, kind, stable_key)
    );
  `);
  const ensureScope = (projectId: string, machineId?: string) => {
    const projects = db.prepare("select machine_id from projects where project_id = ?").all(projectId);
    if (projects.length > 1) throw new Error("Ambiguous project: plan storage is shared across machines with this projectId");
    if (projects.length !== 1 || (machineId !== undefined && projects[0]!.machine_id !== machineId)) throw new Error("Unknown project on this machine");
  };
  return {
    snapshot(projectId: string) {
      ensureScope(projectId);
      const stableKeys = db.prepare("select kind, stable_key, entity_id from cc_project_audit_keys where project_id = ? order by kind, stable_key limit 200")
        .all(projectId).map((entry) => ({ kind: entry.kind as "phase" | "todo", key: entry.stable_key as string, id: entry.entity_id as string }));
      const keys = (kind: "phase" | "todo", id: string) => stableKeys.filter((entry) => entry.kind === kind && entry.id === id).map((entry) => entry.key).slice(0, 10);
      return {
        stableKeys,
        phases: sections.list(projectId).slice(0, 60).map((p) => ({ id: p.id, keys: keys("phase", p.id), name: p.name, status: p.status, summary: p.trying })),
        todos: listMemory(db, { projectId, kind: "todo", limit: 100 }).entries.map((t) => ({ id: t.id, keys: keys("todo", t.id), text: t.text.slice(0, 2000), done: t.done, sectionId: t.sectionId })),
        progress: listMemory(db, { projectId, kind: "progress", limit: 1 }).entries.map((p) => ({ id: p.id, text: p.text.slice(0, 4000) })),
      };
    },
    apply(input: { id: string; machineId: string; projectId: string; report: AuditReport }): ReconcileResult {
      const id = text(input.id, "audit id", 200);
      const machineId = text(input.machineId, "machine id", 200);
      const projectId = text(input.projectId, "project id", 200);
      const report = parseAuditReport(input.report);
      const hash = createHash("sha256").update(JSON.stringify(report)).digest("hex");
      db.exec("begin immediate");
      try {
        ensureScope(projectId, machineId);
        const old = db.prepare("select * from cc_project_audit_imports where id = ?").get(id);
        if (old) {
          if (old.machine_id !== machineId || old.project_id !== projectId || old.report_hash !== hash) throw new Error("Audit id already imported with different content or scope");
          db.exec("commit");
          return JSON.parse(old.result as string) as ReconcileResult;
        }
        const result: ReconcileResult = { addedPhases: 0, addedTodos: 0, progressId: "", questions: [...report.questions] };
        const phaseIds = new Map<string, string>();
        const existingPhases = sections.list(projectId);
        const existingTodos = db.prepare("select id, text from cc_memory where project_id = ? and kind = 'todo'").all(projectId);
        const reconcile = (kind: "phase" | "todo", stableKey: string, label: string, refs: string[], create: () => string, matches: { id: string; text: string }[]) => {
          const ledger = db.prepare("select * from cc_project_audit_keys where machine_id = ? and project_id = ? and kind = ? and stable_key = ?")
            .get(machineId, projectId, kind, stableKey);
          if (ledger) {
            const current = kind === "phase" ? sections.get(ledger.entity_id as string)?.name
              : db.prepare("select text from cc_memory where id = ?").get(ledger.entity_id as string)?.text;
            if (normalize(label) !== ledger.original_text || typeof current !== "string" || normalize(current) !== normalize(label))
              result.questions.push(`Revisá ${kind === "phase" ? "la fase" : "el pendiente"} «${label}»: cambió o fue eliminado; se conservó el registro existente.`);
            return ledger.entity_id as string;
          }
          const same = matches.filter((entry) => normalize(entry.text) === normalize(label));
          if (same.length > 1) result.questions.push(`Hay varios registros para «${label}»; se conservan sin cambios.`);
          const entityId = same[0]?.id ?? create();
          db.prepare("insert into cc_project_audit_keys values (?, ?, ?, ?, ?, ?, ?, ?)")
            .run(machineId, projectId, kind, stableKey, entityId, normalize(label), JSON.stringify(refs), report.revision);
          return entityId;
        };
        for (const phase of report.phases) {
          const phaseId = reconcile("phase", phase.key, phase.name, phase.evidence, () => {
            const created = sections.create({ projectId, name: phase.name, status: phase.status, trying: phase.summary });
            existingPhases.push(created); result.addedPhases++; return created.id;
          }, existingPhases.map((p) => ({ id: p.id, text: p.name })));
          phaseIds.set(phase.key, phaseId);
        }
        for (const todo of report.todos) {
          reconcile("todo", todo.key, todo.text, todo.evidence, () => {
            const phaseId = todo.phaseKey ? phaseIds.get(todo.phaseKey) : undefined;
            const created = saveMemory(db, { projectId, kind: "todo", text: todo.text,
              sectionId: phaseId && sections.get(phaseId) ? phaseId : null }, "agent");
            existingTodos.push({ id: created.id, text: created.text }); result.addedTodos++; return created.id;
          }, existingTodos.map((t) => ({ id: t.id as string, text: t.text as string })));
        }
        const progressText = `${report.progress}\n\nRevisión: ${report.revision}\nFuentes: ${report.evidence.join(", ")}`;
        const latest = listMemory(db, { projectId, kind: "progress", limit: 1 }).entries[0];
        result.progressId = latest?.text === progressText ? latest.id : saveMemory(db, { projectId, kind: "progress", text: progressText }, "agent").id;
        result.questions = [...new Set(result.questions)];
        db.prepare("insert into cc_project_audit_imports values (?, ?, ?, ?, ?)").run(id, machineId, projectId, hash, JSON.stringify(result));
        db.exec("commit");
        return result;
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
    },
  };
}
