import {
  COMMAND_CENTER_WORKFLOW_NODE_LIMIT,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowSlug,
  parseCommandCenterWorkflow,
  type CommandCenterSkillName,
  type CommandCenterWorkflow,
  type CommandCenterWorkflowGateCheck,
  type CommandCenterWorkflowInput,
  type CommandCenterWorkflowOutput,
  type CommandCenterWorkflowNode,
  type CommandCenterWorkflowNodeKind,
  type CommandCenterWorkflowRun,
  type CommandCenterWorkflowRunStatus,
  type CommandCenterWorkflowStep,
  type CommandCenterWorkflowStepStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { Point } from "../canvas/canvasLogic";

// The editor keeps a decoded workflow as its draft. Text fields may hold anything while typing;
// `checkDraft` runs the same parse the server runs on save, so errors match what saving reports.

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 76;
const GAP_X = 72;
const GAP_Y = 32;
const PAD = 40;

export const NODE_LIMIT = COMMAND_CENTER_WORKFLOW_NODE_LIMIT;

export const NODE_KIND_LABEL = {
  agent: "Agent",
  skill: "Skill",
  ask: "Ask",
  parallel: "Parallel",
  gate: "Gate",
} as const satisfies Record<CommandCenterWorkflowNodeKind, string>;

export const STEP_STATUS_LABEL = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting for you",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
} as const satisfies Record<CommandCenterWorkflowStepStatus, string>;

export const RUN_STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting for you",
  succeeded: "Done",
  failed: "Failed",
  stopped: "Stopped",
} as const satisfies Record<CommandCenterWorkflowRunStatus, string>;

type Status = CommandCenterWorkflowStepStatus | CommandCenterWorkflowRunStatus;

/** Badge variant per run or step status. */
export function statusVariant(status: Status) {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "waiting":
      return "warning";
    case "running":
    case "queued":
      return "info";
    default:
      return "outline";
  }
}

export const nodeTitle = (node: CommandCenterWorkflowNode) => node.title ?? node.id;

export const GATE_CHECK_LABEL = {
  tests: "Tests pass",
  typecheck: "Type check passes",
  manual: "You approve",
} as const satisfies Record<CommandCenterWorkflowGateCheck, string>;

export const OUTPUT_LABEL = {
  text: "Reply",
  memory: "Reply and a memory note",
  artifact: "Full reply as an artifact",
} as const satisfies Record<CommandCenterWorkflowOutput, string>;

type AgentNode = Extract<CommandCenterWorkflowNode, { kind: "agent" }>;

/** An agent node's profile: an agent's name (by id or name), a model, or the server default. */
export function profileLabel(
  profile: AgentNode["profile"],
  agents: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) {
  if (profile === undefined) return "Default model";
  if (typeof profile === "string") {
    return agents.find((agent) => agent.id === profile || agent.name === profile)?.name ?? profile;
  }
  return profile.model;
}

/** The line under a node's title on the canvas. */
export function describeNode(
  node: CommandCenterWorkflowNode,
  agents: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): string | null {
  switch (node.kind) {
    case "agent":
      return [
        profileLabel(node.profile, agents),
        node.worktree ? "worktree" : null,
        node.skills.length > 0
          ? `${node.skills.length} skill${node.skills.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "skill":
      return node.skill;
    case "ask":
      return node.question || null;
    case "parallel":
      return `For each of ${node.over || "…"}: ${node.node}`;
    case "gate":
      return GATE_CHECK_LABEL[node.check];
  }
}

/** The parallel node that runs `id` as its body, if any. */
export function parallelParentOf(workflow: CommandCenterWorkflow, id: string) {
  return workflow.nodes.find((node) => node.kind === "parallel" && node.node === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Layout

/**
 * Where every node sits: its saved spot, or for nodes without one a column by graph depth (a
 * parallel body goes under its parallel node). Saving writes these back, so files stay stable.
 */
export function nodePositions(workflow: CommandCenterWorkflow): Map<string, Point> {
  const positions = new Map<string, Point>();
  const missing: CommandCenterWorkflowNode[] = [];
  for (const node of workflow.nodes) {
    const saved = workflow.layout[node.id];
    if (saved) positions.set(node.id, saved);
    else missing.push(node);
  }
  if (missing.length === 0) return positions;

  // Longest path from a root; bounded passes so a cycle cannot loop forever.
  const depth = new Map<string, number>(workflow.nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < workflow.nodes.length; pass++) {
    let changed = false;
    for (const edge of workflow.edges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (depth.has(edge.to) && next > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  const bodies: CommandCenterWorkflowNode[] = [];
  for (const node of missing) {
    if (parallelParentOf(workflow, node.id)) {
      bodies.push(node);
      continue;
    }
    const column = depth.get(node.id) ?? 0;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    positions.set(node.id, {
      x: PAD + column * (NODE_WIDTH + GAP_X),
      y: PAD + row * (NODE_HEIGHT + GAP_Y) * 2,
    });
  }
  for (const node of bodies) {
    const parent = parallelParentOf(workflow, node.id);
    const at = parent ? positions.get(parent.id) : undefined;
    positions.set(node.id, at ? { x: at.x, y: at.y + NODE_HEIGHT + GAP_Y } : { x: PAD, y: PAD });
  }
  return positions;
}

/** The draft with a saved spot for every node (and none for missing ones). */
export function withFullLayout(workflow: CommandCenterWorkflow): CommandCenterWorkflow {
  const positions = nodePositions(workflow);
  return {
    ...workflow,
    layout: Object.fromEntries(
      workflow.nodes.map((node) => [node.id, positions.get(node.id) ?? { x: PAD, y: PAD }]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Edits (each returns a new draft)

const isNodeId = Schema.is(CommandCenterWorkflowNodeId);

export function uniqueNodeId(workflow: CommandCenterWorkflow, base: string) {
  const taken = new Set(workflow.nodes.map((node) => node.id as string));
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return CommandCenterWorkflowNodeId.make(id);
  }
}

/** A new node of `kind` at `at`; a skill node needs a skill to start from. */
export function addNode(
  workflow: CommandCenterWorkflow,
  kind: CommandCenterWorkflowNodeKind,
  at: Point,
  skill: CommandCenterSkillName | null,
): { readonly workflow: CommandCenterWorkflow; readonly id: CommandCenterWorkflowNodeId } {
  const id = uniqueNodeId(workflow, kind);
  let node: CommandCenterWorkflowNode;
  switch (kind) {
    case "agent":
      node = { id, kind, prompt: "", skills: [], worktree: false, outputs: "text" };
      break;
    case "skill":
      node =
        skill === null
          ? { id, kind: "agent", prompt: "", skills: [], worktree: false, outputs: "text" }
          : { id, kind, skill };
      break;
    case "ask":
      node = { id, kind, question: "" };
      break;
    case "parallel": {
      const taken = new Set(
        workflow.nodes.flatMap((candidate) =>
          candidate.kind === "parallel" ? [candidate.node] : [],
        ),
      );
      const body = workflow.nodes.find(
        (candidate) =>
          (candidate.kind === "agent" || candidate.kind === "skill") &&
          !taken.has(candidate.id) &&
          !workflow.edges.some((edge) => edge.from === candidate.id || edge.to === candidate.id),
      );
      node = { id, kind, over: workflow.inputs[0]?.name ?? "", node: body?.id ?? id };
      break;
    }
    case "gate":
      node = { id, kind, check: "tests" };
      break;
  }
  return {
    id,
    workflow: {
      ...workflow,
      nodes: [...workflow.nodes, node],
      layout: {
        ...withFullLayout(workflow).layout,
        [id]: { x: Math.round(at.x), y: Math.round(at.y) },
      },
    },
  };
}

/** Drops the node, its edges and its spot. A parallel node naming it is left for validation. */
export function removeNode(workflow: CommandCenterWorkflow, id: string): CommandCenterWorkflow {
  const { [id]: _removed, ...layout } = workflow.layout;
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.id !== id),
    edges: workflow.edges.filter((edge) => edge.from !== id && edge.to !== id),
    layout,
  };
}

/**
 * Undo for one deleted node, even after later edits: puts it back from `before` (the draft it
 * was deleted from) with its spot and the edges whose other end still exists.
 */
export function restoreNode(
  current: CommandCenterWorkflow,
  before: CommandCenterWorkflow,
  id: string,
): CommandCenterWorkflow {
  const node = before.nodes.find((candidate) => candidate.id === id);
  if (!node || current.nodes.some((candidate) => candidate.id === id)) return current;
  const ids = new Set<string>([...current.nodes.map((candidate) => candidate.id), id]);
  const edges = before.edges.filter(
    (edge) =>
      (edge.from === id || edge.to === id) &&
      ids.has(edge.from) &&
      ids.has(edge.to) &&
      !current.edges.some((other) => other.from === edge.from && other.to === edge.to),
  );
  const spot = before.layout[id];
  return {
    ...current,
    nodes: [...current.nodes, node],
    edges: [...current.edges, ...edges],
    layout: spot ? { ...current.layout, [id]: spot } : current.layout,
  };
}

/** A copy without an optional field (the file leaves it out rather than storing it empty). */
export function omitKey<T extends object, K extends keyof T>(value: T, key: K): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function replaceNode(
  workflow: CommandCenterWorkflow,
  node: CommandCenterWorkflowNode,
): CommandCenterWorkflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((current) => (current.id === node.id ? node : current)),
  };
}

export function moveNode(workflow: CommandCenterWorkflow, id: string, at: Point) {
  return { ...workflow, layout: { ...workflow.layout, [id]: at } };
}

/** Renames a node everywhere it is referenced: edges, layout and parallel nodes. */
export function renameNode(
  workflow: CommandCenterWorkflow,
  from: string,
  to: string,
): { readonly workflow: CommandCenterWorkflow } | { readonly error: string } {
  const next = to.trim();
  if (next === from) return { workflow };
  if (!isNodeId(next)) return { error: "Use letters, digits, - and _ only (up to 64)." };
  if (workflow.nodes.some((node) => node.id === next)) return { error: `"${next}" is taken.` };
  const swap = <T extends string>(id: T) => (id === from ? next : id);
  const { [from]: spot, ...layout } = workflow.layout;
  return {
    workflow: {
      ...workflow,
      nodes: workflow.nodes.map((node) => {
        const renamed = { ...node, id: swap(node.id) };
        return renamed.kind === "parallel"
          ? { ...renamed, node: swap(renamed.node), over: swap(renamed.over) }
          : renamed;
      }),
      edges: workflow.edges.map((edge) => ({ from: swap(edge.from), to: swap(edge.to) })),
      layout: spot ? { ...layout, [next]: spot } : layout,
    },
  };
}

function reaches(workflow: CommandCenterWorkflow, from: string, target: string) {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of workflow.edges) if (edge.from === id) stack.push(edge.to);
  }
  return false;
}

/** `to` runs after `from`. Refuses what validation would reject anyway, with the reason. */
export function connectNodes(
  workflow: CommandCenterWorkflow,
  from: CommandCenterWorkflowNodeId,
  to: CommandCenterWorkflowNodeId,
): { readonly workflow: CommandCenterWorkflow } | { readonly error: string } {
  if (from === to) return { error: "A step cannot wait for itself." };
  if (workflow.edges.some((edge) => edge.from === from && edge.to === to)) {
    return { error: "Those steps are already connected." };
  }
  for (const id of [from, to]) {
    const parent = parallelParentOf(workflow, id);
    if (parent)
      return { error: `"${id}" runs inside "${parent.id}"; connect "${parent.id}" instead.` };
  }
  if (reaches(workflow, to, from)) return { error: "That connection would make a loop." };
  return { workflow: { ...workflow, edges: [...workflow.edges, { from, to }] } };
}

export function disconnectNodes(workflow: CommandCenterWorkflow, from: string, to: string) {
  return {
    ...workflow,
    edges: workflow.edges.filter((edge) => edge.from !== from || edge.to !== to),
  };
}

// ---------------------------------------------------------------------------------------------
// Validation

export interface DraftCheck {
  /** What saving writes (trimmed, every node placed); null while there are errors. */
  readonly workflow: CommandCenterWorkflow | null;
  readonly errors: ReadonlyArray<string>;
  /** Errors naming a node, by node id. */
  readonly byNode: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Errors that name no node. */
  readonly general: ReadonlyArray<string>;
}

export function checkDraft(draft: CommandCenterWorkflow): DraftCheck {
  const result = parseCommandCenterWorkflow(withFullLayout(draft));
  const byNode = new Map<string, string[]>();
  const general: string[] = [];
  for (const error of result.errors) {
    const ids = draft.nodes.filter((node) => error.includes(`"${node.id}"`)).map((node) => node.id);
    if (ids.length === 0) general.push(error);
    for (const id of ids) byNode.set(id, [...(byNode.get(id) ?? []), error]);
  }
  return { workflow: result.workflow, errors: result.errors, byNode, general };
}

// ---------------------------------------------------------------------------------------------
// Library

/** Lowercase words joined by hyphens, from any title. */
export function slugify(title: string) {
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

/** `base`, or `base-2`, `base-3`… when taken. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): CommandCenterWorkflowSlug {
  const root = slugify(base);
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  return CommandCenterWorkflowSlug.make(slug);
}

/** Newest run per workflow; `runs` come newest first. */
export function lastRunBySlug(runs: ReadonlyArray<CommandCenterWorkflowRun>) {
  const result = new Map<string, CommandCenterWorkflowRun>();
  for (const run of runs) if (!result.has(run.slug)) result.set(run.slug, run);
  return result;
}

/** What a run starts with (blank fields take the default) and which required inputs are empty. */
export function runInputs(
  declared: ReadonlyArray<CommandCenterWorkflowInput>,
  values: Readonly<Record<string, string>>,
) {
  const inputs: Record<string, string> = {};
  const missing: string[] = [];
  for (const input of declared) {
    const value = values[input.name]?.trim() ?? "";
    if (value !== "") inputs[input.name] = value;
    else if (!input.default) missing.push(input.label);
  }
  return { inputs, missing };
}

// ---------------------------------------------------------------------------------------------
// Runs

export interface NodeRunState {
  readonly status: CommandCenterWorkflowStepStatus;
  /** The newest attempt per item (one entry unless the node runs inside a parallel node). */
  readonly steps: ReadonlyArray<CommandCenterWorkflowStep>;
}

const STATUS_ORDER: ReadonlyArray<CommandCenterWorkflowStepStatus> = [
  "running",
  "waiting",
  "failed",
  "stopped",
  "pending",
  "skipped",
  "succeeded",
];

/** Each node's state from a run's steps: its newest attempt, or the worst of its items. */
export function nodeRunStates(
  steps: ReadonlyArray<CommandCenterWorkflowStep>,
): Map<string, NodeRunState> {
  const latest = new Map<string, CommandCenterWorkflowStep>();
  for (const step of steps) {
    const key = `${step.nodeId}#${step.item ?? "-"}`;
    const current = latest.get(key);
    if (current === undefined || step.attempt > current.attempt) latest.set(key, step);
  }
  const byNode = new Map<string, CommandCenterWorkflowStep[]>();
  for (const step of latest.values()) {
    byNode.set(step.nodeId, [...(byNode.get(step.nodeId) ?? []), step]);
  }
  const result = new Map<string, NodeRunState>();
  for (const [nodeId, nodeSteps] of byNode) {
    nodeSteps.sort((left, right) => (left.item ?? -1) - (right.item ?? -1));
    const status =
      STATUS_ORDER.find((candidate) => nodeSteps.some((step) => step.status === candidate)) ??
      "pending";
    result.set(nodeId, { status, steps: nodeSteps });
  }
  return result;
}

/** A run's steps from its detail, updated by the live feed (newer `updatedAt` wins). */
export function mergeRunSteps(
  detail: ReadonlyArray<CommandCenterWorkflowStep>,
  live: ReadonlyArray<CommandCenterWorkflowStep>,
  runId: string,
): ReadonlyArray<CommandCenterWorkflowStep> {
  const byId = new Map(detail.map((step) => [step.id, step] as const));
  let changed = false;
  for (const step of live) {
    if (step.runId !== runId) continue;
    const current = byId.get(step.id);
    if (current === undefined || step.updatedAt > current.updatedAt) {
      byId.set(step.id, step);
      changed = true;
    }
  }
  return changed ? [...byId.values()] : detail;
}

export const canStopRun = (status: CommandCenterWorkflowRunStatus) =>
  status === "queued" || status === "running" || status === "waiting";
export const canResumeRun = (status: CommandCenterWorkflowRunStatus) =>
  status === "failed" || status === "stopped";
export const canRetryStep = (status: CommandCenterWorkflowStepStatus) =>
  status === "failed" || status === "stopped";

/**
 * What `retryWorkflowStep` takes for a node's step: a parallel body's item is retried through
 * its parallel node; any other step by its own node.
 */
export function retryTarget(
  workflow: CommandCenterWorkflow,
  step: CommandCenterWorkflowStep,
): { readonly nodeId: CommandCenterWorkflowNodeId; readonly item?: number } {
  const parent = parallelParentOf(workflow, step.nodeId);
  return parent && step.item !== null
    ? { nodeId: parent.id, item: step.item }
    : { nodeId: step.nodeId };
}
