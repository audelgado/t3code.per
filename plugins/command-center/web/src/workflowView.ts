// Pure view logic for the Flujos screen (the screen itself is Workflows.tsx).
import type { Tone } from "./look.ts";
import type { RunStatus, RunSummary, StepStatus, StepView, Workflow, WorkflowInputDef, WorkflowNode } from "../../server/workflows.ts";

export const RUN_LABEL: Record<RunStatus, string> = {
  pending_approval: "Por aprobar",
  running: "En curso",
  needs_you: "Te necesita",
  succeeded: "Listo",
  failed: "Falló",
  cancelled: "Cancelada",
};
export const STEP_LABEL: Record<StepStatus | "pending", string> = {
  pending: "Pendiente",
  running: "En curso",
  waiting: "Te necesita",
  succeeded: "Listo",
  failed: "Falló",
  cancelled: "Cancelada",
};

/** Palette tone (look.ts) of a run or step status. */
export function runTone(status: RunStatus | StepStatus | "pending"): Tone {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "needs_you":
    case "waiting":
    case "pending_approval":
      return "need";
    case "running":
      return "run";
    default:
      return "queue";
  }
}

export const KIND_LABEL: Record<WorkflowNode["kind"], string> = { agent: "Agente", skill: "Skill", ask: "Pregunta", parallel: "En paralelo", gate: "Compuerta" };
/** Tone of a step pill by what the node is (the chain in the design). */
export const KIND_TONE: Record<WorkflowNode["kind"], Tone> = { agent: "run", gate: "need", skill: "teal", ask: "pr", parallel: "queue" };
const GATE_LABEL = { tests: "Pasan los tests", typecheck: "Pasa el chequeo de tipos", manual: "Vos aprobás" } as const;

export const nodeTitle = (n: WorkflowNode) => n.title ?? n.id;

/** The line under a node's title. */
export function describeNode(n: WorkflowNode): string {
  switch (n.kind) {
    case "agent": {
      const parts = [typeof n.profile === "string" ? n.profile : n.profile?.model, n.worktree ? "worktree" : null, n.skills?.length ? `${n.skills.length} skill${n.skills.length === 1 ? "" : "s"}` : null];
      return parts.filter(Boolean).join(" · ") || "Modelo por defecto";
    }
    case "skill":
      return n.skill;
    case "ask":
      return n.question;
    case "parallel":
      return `Para cada elemento de ${n.over}: ${n.node}`;
    case "gate":
      return GATE_LABEL[n.check];
  }
}

/** Nodes in run order: a node after everything it waits for, ties in file order. Cycles (rejected on save) keep file order. */
export function orderNodes(w: Pick<Workflow, "nodes" | "edges">): WorkflowNode[] {
  const left = new Map(w.nodes.map((n) => [n.id, w.edges.filter((e) => e.to === n.id).length]));
  const out: WorkflowNode[] = [];
  const todo = [...w.nodes];
  while (todo.length) {
    const i = todo.findIndex((n) => left.get(n.id) === 0);
    const [n] = todo.splice(i < 0 ? 0 : i, 1) as [WorkflowNode];
    out.push(n);
    for (const e of w.edges) if (e.from === n.id) left.set(e.to, (left.get(e.to) ?? 1) - 1);
  }
  return out;
}

// ---- library ----

/** Lowercase words joined by hyphens, from any title. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)
      .replace(/-+$/, "") || "workflow"
  );
}

/** `base`, or `base-2`, `base-3`... when taken. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const root = slugify(base);
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  return slug;
}

/** A starting point for a new workflow, as editor text. */
export function newWorkflowText(title: string, taken: ReadonlySet<string>): string {
  const w: Workflow = {
    slug: uniqueSlug(title, taken),
    title: title.trim() || "Nuevo flujo",
    description: "",
    inputs: [{ name: "topic", label: "Tema" }],
    nodes: [
      { id: "plan", kind: "agent", prompt: "Planificá el trabajo para: {{input:topic}}" },
      { id: "review", kind: "gate", check: "manual" },
    ],
    edges: [{ from: "plan", to: "review" }],
  };
  return JSON.stringify(w, null, 2);
}

/** Editor text to a value for the server, or what is wrong with the JSON. Shape errors come from the server on save. */
export function parseDraft(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { error: `JSON inválido: ${e instanceof Error ? e.message : "error de lectura"}` };
  }
}

/** The server's 400 text (one problem per line) as a list. */
export const errorLines = (message: string) => message.split("\n").filter((l) => l.trim());

/** Run inputs to send (blank fields take their default on the server) and the labels of required ones left empty. */
export function runInputs(declared: readonly WorkflowInputDef[], values: Readonly<Record<string, string>>) {
  const inputs: Record<string, string> = {};
  const missing: string[] = [];
  for (const d of declared) {
    const v = values[d.name]?.trim() ?? "";
    if (v) inputs[d.name] = v;
    else if (!d.default) missing.push(d.label);
  }
  return { inputs, missing };
}

// ---- runs ----

const rank = (status: RunStatus) => (status === "needs_you" || status === "pending_approval" ? 0 : status === "running" ? 1 : 2);

/** Waiting for you first, then running, then finished; newest first in each. */
export const orderRuns = <R extends Pick<RunSummary, "status" | "createdAt" | "id">>(runs: readonly R[]): R[] =>
  runs.toSorted((a, b) => rank(a.status) - rank(b.status) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));

/** Newest run per workflow slug; `runs` come newest first. */
export function lastRunBySlug<R extends Pick<RunSummary, "slug">>(runs: readonly R[]): Map<string, R> {
  const out = new Map<string, R>();
  for (const r of runs) if (!out.has(r.slug)) out.set(r.slug, r);
  return out;
}

export interface NodeState {
  status: StepStatus | "pending";
  /** One step, or one per item of a parallel node's body. */
  steps: StepView[];
}

const WORST: StepStatus[] = ["running", "waiting", "failed", "cancelled", "succeeded"];

/** Each node's state from the run's steps: the worst status among its steps, "pending" when it has none. */
export function nodeStates(nodes: readonly WorkflowNode[], steps: readonly StepView[]): Map<string, NodeState> {
  const out = new Map<string, NodeState>(nodes.map((n) => [n.id, { status: "pending", steps: [] }]));
  for (const s of steps) out.get(s.nodeId)?.steps.push(s);
  for (const st of out.values()) {
    st.steps.sort((a, b) => (a.item ?? -1) - (b.item ?? -1));
    st.status = WORST.find((w) => st.steps.some((s) => s.status === w)) ?? "pending";
  }
  return out;
}

/** "3 de 5 pasos listos". */
export function progress(workflow: Pick<Workflow, "nodes">, steps: readonly StepView[]): string {
  const done = [...nodeStates(workflow.nodes, steps).values()].filter((s) => s.status === "succeeded").length;
  return `${done} de ${workflow.nodes.length} pasos listos`;
}

export const canCancel = (s: RunStatus) => s === "running" || s === "needs_you";
export const canResume = (s: RunStatus) => s === "failed" || s === "cancelled";

/** Where a step's thread opens: the T3 app link, and the web link when the machine has a web URL. */
export function threadLinks(machine: { id: string; webUrl: string | null }, threadId: string) {
  return { appUrl: `t3code://threads/${machine.id}/${threadId}`, webUrl: machine.webUrl ? `${machine.webUrl.replace(/\/$/, "")}/${machine.id}/${threadId}` : null };
}

/** The node a run waits on, if it waits on you at the top level (an ask or a manual gate), with its waiting step. */
export function waitingStep(workflow: Pick<Workflow, "nodes" | "edges">, steps: readonly StepView[]): { node: WorkflowNode; step: StepView } | null {
  const states = nodeStates(workflow.nodes, steps);
  for (const node of orderNodes(workflow)) {
    const step = states.get(node.id)?.steps.find((s) => s.status === "waiting" && s.item === null);
    if (step) return { node, step };
  }
  return null;
}
