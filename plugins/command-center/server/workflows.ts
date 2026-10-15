// Workflows: a JSON graph of agent, skill, ask, parallel and gate nodes, run on the CC task queue.
// Each agent, skill and check node becomes one task once the nodes before it succeeded (their
// tasks are its dependsOn, so the dispatcher hands their results on); ask and manual gates wait
// for an answer. Nothing polls: call advance() on every dispatcher "changed".
// Wire-up: `const workflows = createWorkflows({ db, tasks: { ...tasks, approve: (id, o) => dispatcher.approve(id, o) },
//   link: (id) => links.get(id)?.link, threads: () => dispatcher.threads() });
//   dispatcher.on("changed", workflows.advance); routes.push(...workflows.routes); mcp.registerTools(workflows.tools)`.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getProject, getTask, listMachines, listProjects } from "./db.ts";
import { TaskError, type Dispatcher } from "./dispatcher.ts";
import { HttpError, type Route } from "./http.ts";
import { resolveProject, ToolError, type ToolDef } from "./mcp.ts";
import type { FileLink } from "./t3link.ts";
import {
  T3Error,
  type ModelSelection,
  type Ok,
  type RuntimeMode,
  type T3Link,
  type Task,
  type TaskInput,
  type TaskSource,
  type TaskStatus,
  type ThreadRow,
  type WorkspaceStrategy,
} from "./types.ts";

// ---- the workflow file (.t3/workflows/<slug>.json) ----

export interface WorkflowInputDef {
  /** Referenced in prompts as `{{input:name}}`. */
  name: string;
  label: string;
  default?: string;
}
interface NodeBase {
  id: string;
  title?: string;
}
export type WorkflowNode = NodeBase &
  (
    | {
        kind: "agent";
        prompt: string;
        /** A profile id, or an inline model. */
        profile?: string | ModelSelection;
        skills?: string[];
        /** Runs in a worktree; later worktree steps and checks of the run share it. */
        worktree?: boolean;
      }
    | { kind: "skill"; skill: string; args?: string }
    | { kind: "ask"; question: string; choices?: string[] }
    /** Runs `node` (an agent or skill node without edges) once per item of `over`: an input name or a node id. */
    | { kind: "parallel"; over: string; node: string }
    /** tests/typecheck run a check task that must end with PASS; manual waits for the user. */
    | { kind: "gate"; check: "tests" | "typecheck" | "manual" }
  );
export interface Workflow {
  slug: string;
  title: string;
  description: string;
  inputs: WorkflowInputDef[];
  nodes: WorkflowNode[];
  edges: { from: string; to: string }[];
}
export interface WorkflowSummary {
  slug: string;
  title: string;
  description: string;
  inputs: WorkflowInputDef[];
  nodeCount: number;
  /** "user" or "agent:<label>": an agent's edit is worth a look before running it. */
  updatedBy: string;
  updatedAt: string;
}

// ---- runs ----

export type RunStatus = "pending_approval" | "running" | "needs_you" | "succeeded" | "failed" | "cancelled";
export type StepStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  slug: string;
  title: string;
  /** Snapshot taken at start; later edits of the workflow do not change a run. */
  workflow: Workflow;
  inputs: Record<string, string>;
  machineId: string;
  projectId: string;
  model: ModelSelection | null;
  /** null while an agent-started run awaits approval. */
  runtimeMode: RuntimeMode | null;
  source: TaskSource;
  status: RunStatus;
  error: string | null;
  /** The worktree of the run's first finished worktree step. */
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
export type RunSummary = Omit<WorkflowRun, "workflow">;

export interface WorkflowStep {
  id: string;
  runId: string;
  nodeId: string;
  /** Item index for a parallel node's children, else null. */
  item: number | null;
  status: StepStatus;
  taskId: string | null;
  /** The task's result, the user's answer, or a parallel node's joined results. */
  output: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface StepView extends WorkflowStep {
  taskStatus: TaskStatus | null;
  threadId: string | null;
}
export interface RunDetail {
  run: WorkflowRun;
  steps: StepView[];
}

/** POST /api/workflow-runs body. */
export interface RunInput {
  slug: string;
  machineId: string;
  projectId: string;
  inputs?: Record<string, string>;
  model?: ModelSelection | null;
  runtimeMode?: RuntimeMode;
}

/** Something a run waits for: approving an agent-started run, an ask, or a manual gate. */
export interface WorkflowNeed {
  runId: string;
  title: string;
  kind: "run_approval" | "ask" | "gate";
  nodeId: string | null;
  text: string;
  choices: string[] | null;
  since: string;
}

// ponytail: augments the HTTP contract from here so types.ts stays untouched; move into it when convenient.
declare module "./types.ts" {
  interface Api {
    "GET /api/workflows": { body: never; res: WorkflowSummary[] };
    "GET /api/workflows/:slug": { body: never; res: Workflow };
    /** Saves (replaces) by slug. 400 lists every validation error, one per line. */
    "POST /api/workflows": { body: Workflow; res: WorkflowSummary };
    "DELETE /api/workflows/:slug": { body: never; res: Ok };
    /** Reads the project's .t3/workflows/*.json through T3 (token needs filesystem:read). */
    "POST /api/workflows/import": { body: { machineId: string; projectId: string }; res: ImportResult };
    "GET /api/workflow-runs": { body: never; res: RunSummary[] };
    "GET /api/workflow-needs": { body: never; res: WorkflowNeed[] };
    "POST /api/workflow-runs": { body: RunInput; res: RunDetail };
    "GET /api/workflow-runs/:id": { body: never; res: RunDetail };
    /** Agent-started runs only; the approver picks the runtime mode of every step. */
    "POST /api/workflow-runs/:id/approve": { body: { runtimeMode: RuntimeMode }; res: RunDetail };
    "POST /api/workflow-runs/:id/reject": { body: never; res: RunDetail };
    "POST /api/workflow-runs/:id/cancel": { body: never; res: RunDetail };
    /** A failed or cancelled run reruns its unfinished steps. */
    "POST /api/workflow-runs/:id/resume": { body: never; res: RunDetail };
    /** ask: `answer`; manual gate: `approved`. */
    "POST /api/workflow-runs/:id/answer": { body: { nodeId: string; answer?: string; approved?: boolean }; res: RunDetail };
  }
}
export interface ImportResult {
  imported: string[];
  errors: { file: string; errors: string[] }[];
}

/** Most items one parallel node fans out over. */
export const FANOUT_MAX = 20;
const NODE_MAX = 100;
const OUTPUT_MAX = 4000;
const RUNTIME_MODES = new Set<string>(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const OPEN_RUN = new Set<RunStatus>(["running", "needs_you"]);
const OPEN_STEP = new Set<StepStatus>(["running", "waiting"]);
const LIVE_TASK = new Set<TaskStatus>(["pending_approval", "queued", "starting", "running", "waiting", "needs_you"]);

// ---- validation (by hand: the plugin has no schema library) ----

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const INPUT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INPUT_REF = /\{\{input:([^}]*)\}\}/g;
const KINDS = ["agent", "skill", "ask", "parallel", "gate"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks a workflow file's parsed JSON: shape first (every problem named), then the graph
 * (edges, parallel bodies, cycles, undeclared `{{input:...}}`). Unknown fields are dropped.
 */
export function parseWorkflow(raw: unknown): { workflow: Workflow | null; errors: string[] } {
  if (!isObj(raw)) return { workflow: null, errors: ["A workflow is a JSON object."] };
  const errors: string[] = [];
  const text = (v: unknown, label: string, max: number, required: boolean): string | undefined => {
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string" || (required && !v.trim()) || v.length > max) {
      errors.push(`${label} must be ${required ? "a non-empty" : "a"} string of at most ${max} characters.`);
      return undefined;
    }
    return v.trim();
  };
  const list = (v: unknown, label: string, max: number): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) {
      errors.push(`${label} must be an array of at most ${max} entries.`);
      return [];
    }
    return v;
  };

  const slug = typeof raw.slug === "string" && raw.slug.length <= 64 && KEBAB.test(raw.slug) ? raw.slug : "";
  if (!slug) errors.push("slug must be lowercase words joined by hyphens, at most 64 characters (e.g. release-notes).");
  const title = text(raw.title, "title", 200, true) ?? "";
  const description = text(raw.description, "description", 2000, false) ?? "";

  const inputs = list(raw.inputs, "inputs", 20).flatMap((i, n): WorkflowInputDef[] => {
    if (!isObj(i) || typeof i.name !== "string" || !INPUT_NAME.test(i.name)) {
      errors.push(`Input #${n + 1} needs a name of letters, digits and underscores.`);
      return [];
    }
    const label = text(i.label, `Input "${i.name}" label`, 200, true);
    const def = text(i.default, `Input "${i.name}" default`, 2000, false);
    return label === undefined ? [] : [{ name: i.name, label, ...(def ? { default: def } : {}) }];
  });

  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0 || raw.nodes.length > NODE_MAX) errors.push(`nodes must be an array of 1-${NODE_MAX} nodes.`);
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes.slice(0, NODE_MAX) : []).flatMap((n, index): WorkflowNode[] => {
    const id = isObj(n) && typeof n.id === "string" && NODE_ID.test(n.id) ? n.id : null;
    const name = id ? `Node "${id}"` : `Node #${index + 1}`;
    if (!isObj(n) || !id) {
      errors.push(`${name} needs an id of letters, digits, "-" and "_" (at most 64).`);
      return [];
    }
    if (typeof n.kind !== "string" || !KINDS.includes(n.kind)) {
      errors.push(`${name} has unknown kind ${JSON.stringify(n.kind ?? null)}; use ${KINDS.join(", ")}.`);
      return [];
    }
    const before = errors.length;
    const base = { id, ...(n.title !== undefined ? { title: text(n.title, `${name} title`, 200, true) } : {}) };
    let node: WorkflowNode;
    if (n.kind === "agent") {
      const p = n.profile;
      const profile =
        p === undefined || (typeof p === "string" && p.length <= 64 && p.trim()) ? p
        : isObj(p) && typeof p.instanceId === "string" && typeof p.model === "string" ? { instanceId: p.instanceId, model: p.model }
        : (errors.push(`${name} profile must be a profile id or {instanceId, model}.`), undefined);
      const skills = list(n.skills, `${name} skills`, 20);
      if (skills.some((s) => typeof s !== "string" || !KEBAB.test(s))) errors.push(`${name} skills must be skill names like "write-tests".`);
      if (n.worktree !== undefined && typeof n.worktree !== "boolean") errors.push(`${name} worktree must be true or false.`);
      node = {
        ...base,
        kind: "agent",
        prompt: text(n.prompt, `${name} prompt`, 20_000, true) ?? "",
        ...(profile !== undefined ? { profile: profile as string | ModelSelection } : {}),
        ...(skills.length ? { skills: skills as string[] } : {}),
        ...(n.worktree === true ? { worktree: true } : {}),
      };
    } else if (n.kind === "skill") {
      if (typeof n.skill !== "string" || !KEBAB.test(n.skill)) errors.push(`${name} skill must be a skill name like "write-tests".`);
      const args = text(n.args, `${name} args`, 2000, false);
      node = { ...base, kind: "skill", skill: String(n.skill), ...(args ? { args } : {}) };
    } else if (n.kind === "ask") {
      const choices = list(n.choices, `${name} choices`, 10);
      if (choices.some((c) => typeof c !== "string" || !c.trim() || c.length > 200)) errors.push(`${name} choices must be non-empty strings of at most 200 characters.`);
      node = { ...base, kind: "ask", question: text(n.question, `${name} question`, 2000, true) ?? "", ...(choices.length ? { choices: choices as string[] } : {}) };
    } else if (n.kind === "parallel") {
      node = { ...base, kind: "parallel", over: text(n.over, `${name} over`, 64, true) ?? "", node: text(n.node, `${name} node`, 64, true) ?? "" };
    } else {
      if (n.check !== "tests" && n.check !== "typecheck" && n.check !== "manual") errors.push(`${name} check must be tests, typecheck or manual.`);
      node = { ...base, kind: "gate", check: n.check as "tests" };
    }
    return errors.length === before ? [node] : [];
  });

  const edges = list(raw.edges, "edges", 500).flatMap((e, n) => {
    if (isObj(e) && typeof e.from === "string" && typeof e.to === "string") return [{ from: e.from, to: e.to }];
    errors.push(`Edge #${n + 1} must be {from, to}.`);
    return [];
  });

  if (errors.length > 0) return { workflow: null, errors };
  const workflow: Workflow = { slug, title, description, inputs, nodes, edges };
  const graph = graphErrors(workflow);
  return graph.length > 0 ? { workflow: null, errors: graph } : { workflow, errors: [] };
}

/** Port of the fork's validateCommandCenterWorkflow. */
function graphErrors(wf: Workflow): string[] {
  const errors: string[] = [];
  const nodes = new Map<string, WorkflowNode>();
  for (const node of wf.nodes) {
    if (nodes.has(node.id)) errors.push(`Node id "${node.id}" is used more than once.`);
    else nodes.set(node.id, node);
  }
  const inputs = new Set<string>();
  for (const input of wf.inputs) {
    if (inputs.has(input.name)) errors.push(`Input "${input.name}" is declared more than once.`);
    inputs.add(input.name);
  }
  const outgoing = new Map<string, string[]>();
  const touched = new Set<string>();
  const seen = new Set<string>();
  for (const { from, to } of wf.edges) {
    const key = `${from}\0${to}`;
    if (!nodes.has(from) || !nodes.has(to)) errors.push(`Edge from "${from}" to "${to}" points at a missing node.`);
    else if (from === to) errors.push(`Edge from "${from}" to itself.`);
    else if (seen.has(key)) errors.push(`Edge from "${from}" to "${to}" is listed twice.`);
    else {
      seen.add(key);
      touched.add(from).add(to);
      outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
    }
  }
  const bodies = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "parallel") continue;
    const body = nodes.get(node.node);
    if (!body) errors.push(`Parallel node "${node.id}" runs "${node.node}", which is not a node.`);
    else if (body.kind !== "agent" && body.kind !== "skill") errors.push(`Parallel node "${node.id}" can only run an agent or skill node.`);
    else if (bodies.has(body.id)) errors.push(`Node "${body.id}" is run by both "${bodies.get(body.id)}" and "${node.id}".`);
    else {
      bodies.set(body.id, node.id);
      if (touched.has(body.id)) errors.push(`Node "${body.id}" runs inside "${node.id}", so it cannot have edges; connect "${node.id}" instead.`);
    }
    if (!inputs.has(node.over) && (!nodes.has(node.over) || node.over === node.id))
      errors.push(`Parallel node "${node.id}" runs over "${node.over}", which is neither an input nor another node.`);
  }
  for (const node of nodes.values()) {
    if (node.kind !== "parallel" || inputs.has(node.over) || !nodes.has(node.over) || node.over === node.id) continue;
    if (bodies.has(node.over)) errors.push(`Parallel node "${node.id}" runs over "${node.over}", which runs inside "${bodies.get(node.over)}"; use "${bodies.get(node.over)}" instead.`);
    else outgoing.set(node.over, [...(outgoing.get(node.over) ?? []), node.id]); // waits for it, like an edge
  }
  // Depth-first search; a node met again while still on the path closes a cycle.
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "open");
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      if (state.get(next) === "open") return [...path.slice(path.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of nodes.keys()) {
    const cycle = state.has(id) ? null : visit(id);
    if (cycle) {
      errors.push(`The edges form a cycle: ${cycle.join(" -> ")}.`);
      break;
    }
  }
  for (const node of nodes.values()) {
    const texts = node.kind === "agent" ? [node.prompt] : node.kind === "skill" ? [node.args ?? ""] : node.kind === "ask" ? [node.question] : [];
    for (const t of texts)
      for (const [, name] of t.matchAll(INPUT_REF))
        if (!inputs.has(name!)) errors.push(`Node "${node.id}" uses {{input:${name}}}, which is not declared in inputs.`);
  }
  return errors;
}

// ---- run helpers (pure) ----

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** Items for a parallel node: a JSON array, else the bullet lines (every line when there are none), at most FANOUT_MAX. */
export function parseItems(text: string): string[] {
  const t = text.trim();
  if (t.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed))
        return parsed.map((i) => (typeof i === "string" ? i : JSON.stringify(i)).trim()).filter(Boolean).slice(0, FANOUT_MAX);
    } catch {
      // Not JSON: read it as lines.
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  const bullets = lines.filter((l) => BULLET.test(l));
  return (bullets.length ? bullets : lines).map((l) => l.replace(BULLET, "").trim()).filter(Boolean).slice(0, FANOUT_MAX);
}

/** A check's verdict: the first line starting with PASS or FAIL (asked for first, so the dispatcher's result cut never drops it). */
export const verdict = (text: string) => text.split(/\r?\n/).find((l) => /^[\s*_`]*(PASS|FAIL)\b/i.test(l))?.trim();
export const checkPassed = (text: string) => /^[\s*_`]*PASS\b/i.test(verdict(text) ?? "");

/** Declared inputs with their defaults; refuses unknown names and missing values. */
export function resolveInputs(declared: WorkflowInputDef[], given: unknown = {}): Record<string, string> {
  if (!isObj(given) || Object.values(given).some((v) => typeof v !== "string" || v.length > 2000))
    throw new TaskError("invalid", "inputs must map names to strings of at most 2000 characters");
  const names = declared.map((i) => i.name);
  const unknown = Object.keys(given).filter((n) => !names.includes(n));
  if (unknown.length) throw new TaskError("invalid", `Unknown input ${unknown.join(", ")}; this workflow takes ${names.join(", ") || "no inputs"}.`);
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const i of declared) {
    const v = (given[i.name] as string | undefined)?.trim() || i.default;
    if (v) out[i.name] = v;
    else missing.push(i.name);
  }
  if (missing.length) throw new TaskError("invalid", `Give a value for ${missing.join(", ")}.`);
  return out;
}

const fill = (text: string, inputs: Record<string, string>, item: string | undefined) =>
  text.replace(INPUT_REF, (_, name: string) => inputs[name.trim()] ?? "").replaceAll("{{item}}", () => item ?? "");

const GATE_PROMPT = (check: "tests" | "typecheck") =>
  `Run this project's ${check === "tests" ? "tests" : "type check"}, scoped to what changed when a full run is slow. Do not edit any files. Start your reply with one line: PASS if everything passes, or FAIL and a one-sentence reason; put any details after it.`;

const nodeTitle = (node: WorkflowNode) => node.title ?? node.id;
const clip = (s: string) => (s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX - 1)}…` : s);

/** What a node waits for: its incoming edges, and the node a parallel runs over. */
function depsOf(wf: Workflow, node: WorkflowNode): string[] {
  const deps = wf.edges.filter((e) => e.to === node.id).map((e) => e.from);
  if (node.kind === "parallel" && !wf.inputs.some((i) => i.name === node.over)) deps.push(node.over);
  return deps;
}

// ---- storage ----

export function initWorkflows(db: DatabaseSync) {
  db.exec(`
    create table if not exists cc_workflows(
      slug text primary key,
      json text not null,
      updated_by text not null,
      updated_at text not null
    );
    create table if not exists cc_workflow_runs(
      id text primary key,
      slug text not null,
      title text not null,
      workflow text not null,
      inputs text not null,
      machine_id text not null,
      project_id text not null,
      model text,
      runtime_mode text,
      source text not null,
      status text not null,
      error text,
      worktree_path text,
      created_at text not null,
      updated_at text not null,
      finished_at text
    );
    create index if not exists cc_workflow_runs_status on cc_workflow_runs(status);
    create table if not exists cc_workflow_steps(
      id text primary key,
      run_id text not null,
      node_id text not null,
      item integer,
      status text not null,
      task_id text,
      output text,
      error text,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists cc_workflow_steps_run on cc_workflow_steps(run_id);
  `);
}

type Row = Record<string, unknown>;
const toSummary = (r: Row): WorkflowSummary => {
  const wf = JSON.parse(r.json as string) as Workflow;
  return { slug: wf.slug, title: wf.title, description: wf.description, inputs: wf.inputs, nodeCount: wf.nodes.length, updatedBy: r.updated_by as string, updatedAt: r.updated_at as string };
};
const toRun = (r: Row): WorkflowRun => ({
  id: r.id as string,
  slug: r.slug as string,
  title: r.title as string,
  workflow: JSON.parse(r.workflow as string),
  inputs: JSON.parse(r.inputs as string),
  machineId: r.machine_id as string,
  projectId: r.project_id as string,
  model: r.model ? JSON.parse(r.model as string) : null,
  runtimeMode: r.runtime_mode as RuntimeMode | null,
  source: r.source as TaskSource,
  status: r.status as RunStatus,
  error: r.error as string | null,
  worktreePath: r.worktree_path as string | null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  finishedAt: r.finished_at as string | null,
});
const toStep = (r: Row): WorkflowStep => ({
  id: r.id as string,
  runId: r.run_id as string,
  nodeId: r.node_id as string,
  item: r.item as number | null,
  status: r.status as StepStatus,
  taskId: r.task_id as string | null,
  output: r.output as string | null,
  error: r.error as string | null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function getWorkflow(db: DatabaseSync, slug: string): Workflow | undefined {
  const row = db.prepare("select json from cc_workflows where slug = ?").get(slug);
  return row && (JSON.parse(row.json as string) as Workflow);
}

// ---- the service ----

export interface WorkflowDeps {
  db: DatabaseSync;
  /** createTask should be the profile-applying one main.ts gives the MCP. */
  tasks: Pick<Dispatcher, "createTask" | "cancel" | "approve">;
  link: (machineId: string) => (T3Link & Partial<FileLink>) | undefined;
  /** Live shell rows; read for a finished worktree step's worktreePath. */
  threads: () => ThreadRow[];
  /** Called after a command changes a run (main passes its SSE/push pulse); task-driven changes already pulse. */
  onChange?: () => void;
  newId?: () => string;
}

export function createWorkflows(deps: WorkflowDeps) {
  const { db, tasks } = deps;
  const newId = deps.newId ?? randomUUID;
  const iso = () => new Date().toISOString();
  initWorkflows(db);

  const invalid = (m: string) => new TaskError("invalid", m);
  const conflict = (m: string) => new TaskError("conflict", m);

  // -- library --

  function list(): WorkflowSummary[] {
    return db.prepare("select * from cc_workflows order by slug").all().map(toSummary);
  }
  function save(raw: unknown, by: string): WorkflowSummary {
    const { workflow, errors } = parseWorkflow(raw);
    if (!workflow) throw invalid(errors.join("\n"));
    db.prepare(
      "insert into cc_workflows(slug, json, updated_by, updated_at) values (?, ?, ?, ?) on conflict(slug) do update set json = excluded.json, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    ).run(workflow.slug, JSON.stringify(workflow), by, iso());
    return toSummary(db.prepare("select * from cc_workflows where slug = ?").get(workflow.slug)!);
  }
  function get(slug: string): Workflow {
    return getWorkflow(db, slug) ?? notFound("workflow");
  }

  async function importFrom(machineId: unknown, projectId: unknown): Promise<ImportResult> {
    const project = typeof machineId === "string" && typeof projectId === "string" ? getProject(db, machineId, projectId) : undefined;
    if (!project) throw invalid("unknown project");
    const link = deps.link(project.machineId);
    if (link?.state.status !== "online" || !link.listEntries || !link.readFile) throw conflict("Machine is not online");
    const result: ImportResult = { imported: [], errors: [] };
    const ls = link.listEntries.bind(link);
    const has = async (dir: string, path: string) => (await ls(project.workspaceRoot, dir)).some((e) => e.path === path && e.kind === "directory");
    let entries;
    try {
      entries = await ls(project.workspaceRoot, ".t3/workflows");
    } catch (e) {
      // T3 answers a missing folder like any other read failure; listing the parents tells them apart (and rethrows auth errors).
      if (e instanceof T3Error && !((await has("", ".t3")) && (await has(".t3", ".t3/workflows")))) throw new TaskError("not_found", "No .t3/workflows folder in this project.");
      throw e;
    }
    const files = entries.filter((e) => e.kind === "file" && e.path.endsWith(".json"));
    for (const { path } of files.slice(0, 100)) {
      const { contents, truncated } = await link.readFile(project.workspaceRoot, path);
      let parsed: unknown;
      try {
        parsed = truncated ? undefined : JSON.parse(contents);
      } catch {
        // reported below
      }
      if (parsed === undefined) {
        result.errors.push({ file: path, errors: [truncated ? "File is too large." : "File is not valid JSON."] });
        continue;
      }
      try {
        result.imported.push(save(parsed, "user").slug);
      } catch (e) {
        result.errors.push({ file: path, errors: (e as Error).message.split("\n") });
      }
    }
    return result;
  }

  // -- runs: storage --

  const getRun = (id: string) => {
    const row = db.prepare("select * from cc_workflow_runs where id = ?").get(id);
    return row ? toRun(row) : notFound("run");
  };
  function updateRun(id: string, patch: Partial<Pick<WorkflowRun, "status" | "error" | "runtimeMode" | "worktreePath" | "finishedAt">>) {
    const cols = Object.keys(patch);
    db.prepare(`update cc_workflow_runs set ${cols.map((c) => `${snake(c)} = :${c}`).join(", ")}, updated_at = :now where id = :id`).run({ ...patch, now: iso(), id });
  }
  const steps = (runId: string) => db.prepare("select * from cc_workflow_steps where run_id = ? order by created_at, item").all(runId).map(toStep);
  function addStep(runId: string, nodeId: string, item: number | null, s: Partial<WorkflowStep>, id = newId()): WorkflowStep {
    const now = iso();
    const step: WorkflowStep = { id, runId, nodeId, item, status: "running", taskId: null, output: null, error: null, createdAt: now, updatedAt: now, ...s };
    db.prepare(
      "insert into cc_workflow_steps(id, run_id, node_id, item, status, task_id, output, error, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(step.id, runId, nodeId, item, step.status, step.taskId, step.output, step.error, now, now);
    return step;
  }
  /** Updates the row and the object in place, so a pass keeps working on current state. */
  function setStep(step: WorkflowStep, patch: Pick<WorkflowStep, "status"> & Partial<Pick<WorkflowStep, "output" | "error">>) {
    Object.assign(step, patch, { updatedAt: iso() });
    db.prepare("update cc_workflow_steps set status = ?, output = ?, error = ?, updated_at = ? where id = ?").run(step.status, step.output, step.error, step.updatedAt, step.id);
    dirty = true;
  }

  function detail(id: string): RunDetail {
    return {
      run: getRun(id),
      steps: steps(id).map((s) => {
        const task = s.taskId ? getTask(db, s.taskId) : undefined;
        return { ...s, taskStatus: task?.status ?? null, threadId: task?.threadId ?? null };
      }),
    };
  }

  // -- runs: commands --

  function start(input: RunInput, source: TaskSource): RunDetail {
    if (!isObj(input) || typeof input.slug !== "string") throw invalid("slug required");
    const workflow = get(input.slug);
    if (typeof input.machineId !== "string" || typeof input.projectId !== "string" || !getProject(db, input.machineId, input.projectId)) throw invalid("unknown project");
    if (input.runtimeMode !== undefined && !RUNTIME_MODES.has(input.runtimeMode)) throw invalid("invalid runtimeMode");
    const m = input.model;
    if (m != null && (!isObj(m) || typeof m.instanceId !== "string" || typeof m.model !== "string")) throw invalid("invalid model");
    const inputs = resolveInputs(workflow.inputs, input.inputs);
    const agent = source !== "user";
    const now = iso();
    const id = newId();
    db.prepare(
      `insert into cc_workflow_runs(id, slug, title, workflow, inputs, machine_id, project_id, model, runtime_mode, source, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      workflow.slug,
      workflow.title,
      JSON.stringify(workflow),
      JSON.stringify(inputs),
      input.machineId,
      input.projectId,
      m ? JSON.stringify({ instanceId: m.instanceId, model: m.model }) : null,
      // Agents never pick a runtime mode; the human approver does.
      agent ? null : (input.runtimeMode ?? "full-access"),
      source,
      agent ? "pending_approval" : "running",
      now,
      now,
    );
    advance();
    deps.onChange?.();
    return detail(id);
  }

  function approve(id: string, runtimeMode: unknown): RunDetail {
    const run = getRun(id);
    if (run.status !== "pending_approval") throw conflict("run is not awaiting approval");
    if (typeof runtimeMode !== "string" || !RUNTIME_MODES.has(runtimeMode)) throw invalid("runtimeMode is required");
    updateRun(id, { status: "running", runtimeMode: runtimeMode as RuntimeMode });
    advance();
    deps.onChange?.();
    return detail(id);
  }

  const live = (taskId: string | null) => {
    const status = taskId ? getTask(db, taskId)?.status : undefined;
    return status !== undefined && LIVE_TASK.has(status);
  };

  /**
   * Marks the run finished and its open steps cancelled, then cancels their tasks (queued ones locally, running ones interrupt).
   * Resolves to the error it recorded: names the tasks T3 could not interrupt, which keep running.
   */
  async function stop(run: WorkflowRun, status: "failed" | "cancelled", error: string): Promise<string> {
    updateRun(run.id, { status, error, finishedAt: iso() });
    const open = steps(run.id).filter((s) => OPEN_STEP.has(s.status));
    for (const s of open) setStep(s, { status: "cancelled", error: "run stopped" });
    await Promise.allSettled(open.flatMap((s) => (s.taskId ? [tasks.cancel(s.taskId)] : [])));
    const stuck = open.filter((s) => live(s.taskId)).length;
    if (!stuck) return error;
    const full = `${error}; ${stuck} running step${stuck === 1 ? "" : "s"} could not be interrupted, stop ${stuck === 1 ? "it" : "them"} in T3`;
    updateRun(run.id, { error: full });
    deps.onChange?.();
    return full;
  }

  async function cancel(id: string): Promise<RunDetail> {
    const run = getRun(id);
    if (run.status !== "pending_approval" && !OPEN_RUN.has(run.status)) throw conflict(`run is ${run.status}`);
    const error = run.status === "pending_approval" ? "rejected" : "cancelled";
    const recorded = await stop(run, "cancelled", error);
    deps.onChange?.();
    if (recorded !== error) throw new T3Error("fail", recorded);
    return detail(id);
  }

  function resume(id: string): RunDetail {
    const run = getRun(id);
    if (run.status !== "failed" && run.status !== "cancelled") throw conflict(`run is ${run.status}`);
    // Rerunning beside a step T3 never stopped would put two agents in one worktree.
    if (steps(id).some((s) => live(s.taskId))) throw conflict("A step of this run is still running; stop it in T3 first.");
    db.prepare("delete from cc_workflow_steps where run_id = ? and status != 'succeeded'").run(id);
    updateRun(id, { status: run.runtimeMode === null ? "pending_approval" : "running", error: null, finishedAt: null });
    advance();
    deps.onChange?.();
    return detail(id);
  }

  function answer(id: string, body: unknown, by: TaskSource): RunDetail {
    const run = getRun(id);
    const b = isObj(body) ? body : {};
    const node = run.workflow.nodes.find((n) => n.id === b.nodeId);
    const step = steps(id).find((s) => s.nodeId === b.nodeId && s.item === null);
    if (!OPEN_RUN.has(run.status) || !node || step?.status !== "waiting") throw conflict("That step is not waiting for an answer.");
    if (node.kind === "ask") {
      const a = typeof b.answer === "string" ? b.answer.trim() : "";
      if (!a || a.length > 2000) throw invalid("answer must be 1-2000 characters");
      if (node.choices && !node.choices.includes(a)) throw invalid(`answer must be one of: ${node.choices.join(", ")}`);
      setStep(step, { status: "succeeded", output: a });
    } else {
      // A manual gate is the human checkpoint of a run; an agent never passes it.
      if (by !== "user") throw conflict("Only the user can pass a manual gate.");
      if (typeof b.approved !== "boolean") throw invalid("approved must be true or false");
      setStep(step, b.approved ? { status: "succeeded", output: "Approved" } : { status: "failed", error: "Rejected by the user" });
    }
    advance();
    deps.onChange?.();
    return detail(id);
  }

  function needs(): WorkflowNeed[] {
    const out: WorkflowNeed[] = [];
    for (const row of db.prepare("select * from cc_workflow_runs where status in ('pending_approval', 'needs_you') order by created_at").all()) {
      const run = toRun(row);
      if (run.status === "pending_approval") {
        out.push({ runId: run.id, title: run.title, kind: "run_approval", nodeId: null, text: `${run.source} wants to run this workflow.`, choices: null, since: run.updatedAt });
        continue;
      }
      for (const s of steps(run.id)) {
        const node = run.workflow.nodes.find((n) => n.id === s.nodeId);
        if (s.status !== "waiting" || !node) continue;
        out.push({
          runId: run.id,
          title: run.title,
          kind: node.kind === "ask" ? "ask" : "gate",
          nodeId: node.id,
          text: node.kind === "ask" ? node.question : `Pass "${nodeTitle(node)}"?`,
          choices: node.kind === "ask" ? (node.choices ?? null) : null,
          since: s.createdAt,
        });
      }
    }
    return out;
  }

  // -- the engine --

  let busy = false;
  let dirty = false;

  /** Moves every open run forward. Synchronous and re-entrant safe (task changes re-emit "changed"). */
  function advance() {
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    try {
      do {
        dirty = false;
        for (const row of db.prepare("select * from cc_workflow_runs where status in ('running', 'needs_you')").all()) {
          const run = toRun(row);
          try {
            pass(run);
          } catch (e) {
            console.error(`[cc] workflow run ${run.id} failed: ${e instanceof Error ? e.message : String(e)}`);
            void stop(run, "failed", "internal error");
          }
        }
      } while (dirty);
    } finally {
      busy = false;
    }
  }

  function pass(run: WorkflowRun) {
    const wf = run.workflow;
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
    const bodies = new Set(wf.nodes.flatMap((n) => (n.kind === "parallel" ? [n.node] : [])));
    const all = steps(run.id);
    const top = new Map(all.filter((s) => s.item === null).map((s) => [s.nodeId, s]));
    const children = (p: Extract<WorkflowNode, { kind: "parallel" }>) => all.filter((s) => s.nodeId === p.node && s.item !== null);

    // Steps follow their tasks.
    for (const s of all) {
      const task = s.status === "running" && s.taskId ? getTask(db, s.taskId) : undefined;
      if (!task || (task.status !== "done" && task.status !== "failed" && task.status !== "cancelled")) continue;
      const node = nodes.get(s.nodeId)!;
      if (task.status !== "done") {
        setStep(s, { status: task.status, error: task.error ?? task.status });
      } else if (node.kind === "gate" && !checkPassed(task.result ?? "")) {
        setStep(s, { status: "failed", output: task.result, error: `Check failed: ${verdict(task.result ?? "")?.slice(0, 200) || "no verdict"}` });
      } else {
        setStep(s, { status: "succeeded", output: task.result });
        if (node.kind === "agent" && node.worktree && s.item === null && !run.worktreePath) {
          const row = deps.threads().find((r) => r.machineId === task.machineId && r.id === task.threadId) as { worktreePath?: string | null } | undefined;
          if (row?.worktreePath) updateRun(run.id, { worktreePath: (run.worktreePath = row.worktreePath) });
        }
      }
    }

    // A parallel node settles once every item ended.
    for (const node of wf.nodes) {
      const parent = top.get(node.id);
      if (node.kind !== "parallel" || parent?.status !== "running") continue;
      const kids = children(node);
      if (kids.some((k) => OPEN_STEP.has(k.status))) continue;
      const missed = kids.filter((k) => k.status !== "succeeded").length;
      setStep(
        parent,
        missed
          ? { status: "failed", error: `${missed} of ${kids.length} items did not succeed.` }
          : { status: "succeeded", output: clip(kids.map((k) => k.output ?? "").join("\n\n").trim()) || "No items." },
      );
    }

    // A failed or cancelled step stops the run.
    const bad = all.find((s) => s.status === "failed" || s.status === "cancelled");
    if (bad) {
      const node = nodes.get(bad.nodeId);
      void stop(run, "failed", `${node ? nodeTitle(node) : bad.nodeId}${bad.item !== null ? ` #${bad.item + 1}` : ""}: ${bad.error ?? "failed"}`);
      return;
    }

    // Start every node whose dependencies succeeded.
    for (const node of wf.nodes) {
      if (bodies.has(node.id) || top.has(node.id) || !depsOf(wf, node).every((id) => top.get(id)?.status === "succeeded")) continue;
      if (node.kind === "ask" || (node.kind === "gate" && node.check === "manual")) {
        top.set(node.id, addStep(run.id, node.id, null, { status: "waiting" }));
      } else if (node.kind === "parallel") {
        top.set(node.id, addStep(run.id, node.id, null, { status: "running" }));
        const over = wf.inputs.some((i) => i.name === node.over) ? run.inputs[node.over] : top.get(node.over)?.output;
        const items = parseItems(over ?? "");
        const done = new Set(children(node).map((k) => k.item));
        items.forEach((value, index) => {
          if (!done.has(index)) all.push(launch(run, nodes.get(node.node)!, node, { index, value, total: items.length }, top));
        });
      } else {
        top.set(node.id, launch(run, node, node, null, top));
      }
      dirty = true;
    }

    // Status.
    const status: RunStatus = wf.nodes.every((n) => bodies.has(n.id) || top.get(n.id)?.status === "succeeded")
      ? "succeeded"
      : [...top.values()].some((s) => s.status === "waiting")
        ? "needs_you"
        : "running";
    if (status !== run.status) {
      updateRun(run.id, { status, ...(status === "succeeded" ? { finishedAt: iso() } : {}) });
      dirty = true;
    }
  }

  /** Creates the task of an agent, skill or check step. `anchor` is the node whose edges give the handoff (the parallel parent for an item). */
  function launch(
    run: WorkflowRun,
    node: WorkflowNode,
    anchor: WorkflowNode,
    item: { index: number; value: string; total: number } | null,
    top: Map<string, WorkflowStep>,
  ): WorkflowStep {
    const wf = run.workflow;
    const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
    // Results of the steps before (through asks and gates, whose answers come along), as dependsOn.
    // A parallel node hands on its joined, clipped output instead: up to 20 item results would overflow T3's turn input.
    const dependsOn: string[] = [];
    const answers: string[] = [];
    const joined: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      const n = nodes.get(id);
      const s = top.get(id);
      if (seen.has(id) || !n || !s) return;
      seen.add(id);
      if (n.kind === "parallel") joined.push(`Results of "${nodeTitle(n)}":\n\n${s.output ?? ""}`);
      else if (s.taskId) dependsOn.push(s.taskId);
      if (n.kind === "ask") answers.push(`${n.question}\n${s.output}`);
      if (n.kind === "ask" || n.kind === "gate") for (const e of wf.edges) if (e.to === id) visit(e.from);
    };
    for (const e of wf.edges) if (e.to === anchor.id) visit(e.from);

    const body =
      node.kind === "agent" ? node.prompt
      : node.kind === "skill" ? `Use the "${node.skill}" skill.${node.args ? `\n\n${node.args}` : ""}`
      : GATE_PROMPT(node.kind === "gate" && node.check === "typecheck" ? "typecheck" : "tests");
    const prompt = [
      `You are running the step "${nodeTitle(node)}" of the workflow "${wf.title}".`,
      fill(body, run.inputs, item?.value),
      item && !body.includes("{{item}}") ? `Item ${item.index + 1} of ${item.total}: ${item.value}` : "",
      node.kind === "agent" && node.skills?.length ? `Use these skills: ${node.skills.join(", ")}.` : "",
      answers.length ? `Answers from the user:\n\n${answers.join("\n\n")}` : "",
      ...joined,
    ]
      .filter(Boolean)
      .join("\n\n");

    const id = newId();
    const worktree = node.kind === "agent" && node.worktree;
    // Items always get their own worktree (they run at once); other worktree steps and checks share the run's.
    const workspace: WorkspaceStrategy =
      run.worktreePath && item === null && (worktree || node.kind === "gate") ? { type: "existing_worktree", worktreePath: run.worktreePath }
      : worktree ? { type: "worktree", baseRef: "HEAD", branch: `wf/${run.slug}-${node.id}-${id.replaceAll("-", "").slice(0, 8)}` }
      : { type: "root" };
    const profile = node.kind === "agent" ? node.profile : undefined;
    const input: TaskInput = {
      prompt,
      title: `${wf.title}: ${nodeTitle(node)}${item ? ` ${item.index + 1}` : ""}`,
      machineId: run.machineId,
      projectId: run.projectId,
      model: typeof profile === "object" ? profile : run.model,
      ...(typeof profile === "string" ? { profileId: profile } : {}),
      runtimeMode: run.runtimeMode!,
      workspace,
      dependsOn,
    };
    try {
      let task: Task = tasks.createTask(input, run.source);
      // The run was approved by a human with this runtime mode; its agent-sourced tasks inherit that approval.
      if (task.status === "pending_approval") task = tasks.approve(task.id, { runtimeMode: run.runtimeMode! });
      return addStep(run.id, node.id, item?.index ?? null, { status: "running", taskId: task.id }, id);
    } catch (e) {
      return addStep(run.id, node.id, item?.index ?? null, { status: "failed", error: e instanceof Error ? e.message : String(e) }, id);
    }
  }

  // -- HTTP --

  const http = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TaskError) throw new HttpError(e.code === "invalid" ? 400 : e.code === "not_found" ? 404 : 409, e.code, e.message);
      if (e instanceof T3Error) throw new HttpError(502, "t3_error", e.message);
      throw e;
    }
  };
  const routes: Route[] = [
    { method: "GET", path: "/api/workflows", auth: "cookie", handler: () => list() },
    { method: "GET", path: "/api/workflows/:slug", auth: "cookie", handler: ({ params }) => http(() => get(params.slug!)) },
    { method: "POST", path: "/api/workflows", auth: "cookie", handler: ({ body }) => http(() => save(body, "user")) },
    {
      method: "DELETE",
      path: "/api/workflows/:slug",
      auth: "cookie",
      handler: ({ params }) => {
        if (db.prepare("delete from cc_workflows where slug = ? returning 1").get(params.slug!) === undefined) throw new HttpError(404, "not_found", "workflow not found");
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/workflows/import",
      auth: "cookie",
      handler: ({ body }) => http(() => importFrom(isObj(body) ? body.machineId : undefined, isObj(body) ? body.projectId : undefined)),
    },
    {
      method: "GET",
      path: "/api/workflow-runs",
      auth: "cookie",
      handler: () =>
        db.prepare("select * from cc_workflow_runs order by created_at desc limit 50").all().map((r): RunSummary => {
          const { workflow: _, ...summary } = toRun(r);
          return summary;
        }),
    },
    { method: "GET", path: "/api/workflow-needs", auth: "cookie", handler: () => needs() },
    { method: "POST", path: "/api/workflow-runs", auth: "cookie", handler: ({ body }) => http(() => start(body as RunInput, "user")) },
    { method: "GET", path: "/api/workflow-runs/:id", auth: "cookie", handler: ({ params }) => http(() => detail(params.id!)) },
    {
      method: "POST",
      path: "/api/workflow-runs/:id/approve",
      auth: "cookie",
      handler: ({ params, body }) => http(() => approve(params.id!, isObj(body) ? body.runtimeMode : undefined)),
    },
    {
      method: "POST",
      path: "/api/workflow-runs/:id/reject",
      auth: "cookie",
      handler: ({ params }) =>
        http(() => {
          if (getRun(params.id!).status !== "pending_approval") throw conflict("run is not awaiting approval");
          return cancel(params.id!);
        }),
    },
    { method: "POST", path: "/api/workflow-runs/:id/cancel", auth: "cookie", handler: ({ params }) => http(() => cancel(params.id!)) },
    { method: "POST", path: "/api/workflow-runs/:id/resume", auth: "cookie", handler: ({ params }) => http(() => resume(params.id!)) },
    { method: "POST", path: "/api/workflow-runs/:id/answer", auth: "cookie", handler: ({ params, body }) => http(() => answer(params.id!, body, "user")) },
  ];

  // -- MCP (TaskError messages reach the agent as tool errors) --

  const ownRun = (agent: string, id: unknown) => {
    const row = typeof id === "string" ? db.prepare("select * from cc_workflow_runs where id = ? and source = ?").get(id, `agent:${agent}`) : undefined;
    if (!row) throw new ToolError("Run not found");
    return toRun(row);
  };
  const slugArg = { type: "object", properties: { slug: { type: "string", description: "Workflow slug from workflow_list." } }, required: ["slug"] };
  const runArg = { type: "object", properties: { run_id: { type: "string", description: "Run id from workflow_run." } }, required: ["run_id"] };
  const brief = ({ run, steps }: RunDetail) => ({
    id: run.id,
    workflow: run.slug,
    status: run.status,
    error: run.error,
    steps: steps.map((s) => ({ node: s.nodeId, item: s.item, status: s.status, taskId: s.taskId, error: s.error, output: s.output?.slice(0, 1000) ?? null })),
  });

  const tools: ToolDef[] = [
    {
      name: "workflow_list",
      description: "The user's workflow library: reusable graphs of agent, skill, ask, parallel and gate steps.",
      inputSchema: { type: "object", properties: {} },
      handler: () => list(),
    },
    {
      name: "workflow_get",
      description: "One workflow as JSON (slug from workflow_list). Edit it and pass it to workflow_save.",
      inputSchema: slugArg,
      handler: (args) => {
        const wf = typeof args.slug === "string" ? getWorkflow(db, args.slug) : undefined;
        if (!wf) throw new ToolError("Workflow not found");
        return wf;
      },
    },
    {
      name: "workflow_save",
      description:
        'Create or replace a workflow by slug. Shape: {slug, title, description?, inputs?: [{name, label, default?}], nodes: [...], edges?: [{from, to}]}. Node kinds: agent {prompt, profile?, skills?, worktree?}, skill {skill, args?}, ask {question, choices?}, parallel {over: input name or node id, node: agent/skill node id without edges}, gate {check: "tests"|"typecheck"|"manual"}. Every node has id and optional title. Prompts use {{input:name}} and, inside a parallel, {{item}}. Edges must not form a cycle. Validation errors come back one per line.',
      inputSchema: { type: "object", properties: { workflow: { type: "object", description: "The whole workflow." } }, required: ["workflow"] },
      handler: (args, agent) => save(args.workflow, `agent:${agent}`),
    },
    {
      name: "workflow_run",
      description:
        "Start a workflow on a project. The run waits for the user to approve it in the Command Center (they pick its permissions), then each step runs as a task. Follow it with workflow_status.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          project: { type: "string", description: "Project id, a path inside the project, or its title (see machines_list)." },
          machine: { type: "string", description: "Machine id or label, when the project exists on several machines." },
          inputs: { type: "object", additionalProperties: { type: "string" }, description: "Values by input name; omitted ones take their default." },
        },
        required: ["slug", "project"],
      },
      handler: (args, agent) => {
        if (typeof args.project !== "string" || (args.machine !== undefined && typeof args.machine !== "string")) throw new ToolError("project must be a string");
        const machines = listMachines(db);
        let candidates = listProjects(db);
        if (typeof args.machine === "string") {
          const q = args.machine.toLowerCase();
          const ms = machines.filter((m) => m.id === args.machine || m.label.toLowerCase() === q);
          if (ms.length !== 1) throw new ToolError(`${ms.length ? "Ambiguous" : "Unknown"} machine "${args.machine}"; machines: ${machines.map((m) => m.label).join(", ")}`);
          candidates = candidates.filter((p) => p.machineId === ms[0]!.id);
        }
        const target = resolveProject(candidates, args.project, (id) => machines.find((m) => m.id === id)?.label ?? id);
        const run = start({ slug: String(args.slug), machineId: target.machineId, projectId: target.id, inputs: args.inputs as Record<string, string> | undefined }, `agent:${agent}`);
        return { ...brief(run), note: "Waiting for the user's approval." };
      },
    },
    {
      name: "workflow_answer",
      description: "Answer a waiting ask step of one of your runs (status needs_you in workflow_status), with the user's answer. Manual gates are for the user only.",
      inputSchema: {
        type: "object",
        properties: { run_id: { type: "string" }, node: { type: "string", description: "The ask node id." }, answer: { type: "string" } },
        required: ["run_id", "node", "answer"],
      },
      handler: (args, agent) => brief(answer(ownRun(agent, args.run_id).id, { nodeId: args.node, answer: args.answer }, `agent:${agent}`)),
    },
    {
      name: "workflow_status",
      description: "One of your runs with each step's status and output (at most 1000 characters per step).",
      inputSchema: runArg,
      handler: (args, agent) => brief(detail(ownRun(agent, args.run_id).id)),
    },
  ];

  return { routes, tools, advance, needs, detail, save, start, approve, answer, cancel, resume };
}

function notFound(what: string): never {
  throw new TaskError("not_found", `${what} not found`);
}
