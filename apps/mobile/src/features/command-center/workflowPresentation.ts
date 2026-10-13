import type {
  CommandCenterWorkflow,
  CommandCenterWorkflowInput,
  CommandCenterWorkflowRetryStepInput,
  CommandCenterWorkflowRun,
  CommandCenterWorkflowRunStatus,
  CommandCenterWorkflowStep,
  CommandCenterWorkflowStepStatus,
} from "@t3tools/contracts";

export const RUN_STATUS_LABEL: Record<CommandCenterWorkflowRunStatus, string> = {
  queued: "Queued",
  running: "Running",
  waiting: "Waiting on you",
  succeeded: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const STEP_STATUS_LABEL: Record<CommandCenterWorkflowStepStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting: "Waiting on you",
  succeeded: "Done",
  failed: "Failed",
  skipped: "Skipped",
  stopped: "Stopped",
};

const OPEN_RUN = new Set<CommandCenterWorkflowRunStatus>(["queued", "running", "waiting"]);

export const canStopRun = (run: CommandCenterWorkflowRun) => OPEN_RUN.has(run.status);
export const canResumeRun = (run: CommandCenterWorkflowRun) =>
  run.status === "failed" || run.status === "stopped";

/**
 * The values to send when starting a run: blank fields are left out so the server applies the
 * input's default; `missing` names the inputs with neither a value nor a default.
 */
export function workflowStartInputs(
  inputs: ReadonlyArray<CommandCenterWorkflowInput>,
  values: Readonly<Record<string, string>>,
) {
  const sent: Record<string, string> = {};
  const missing: string[] = [];
  for (const input of inputs) {
    const value = (values[input.name] ?? "").trim();
    if (value !== "") sent[input.name] = value;
    else if (!input.default) missing.push(input.label);
  }
  return { inputs: sent, missing };
}

/**
 * Steps of one run from the run query and the live feed, by id; the newer row wins. The live
 * snapshot leaves out steps of finished runs, and the query goes stale while the run moves.
 */
export function mergeRunSteps(
  runId: string,
  fetched: ReadonlyArray<CommandCenterWorkflowStep>,
  live: ReadonlyArray<CommandCenterWorkflowStep>,
): ReadonlyArray<CommandCenterWorkflowStep> {
  const byId = new Map<string, CommandCenterWorkflowStep>();
  for (const step of [...fetched, ...live]) {
    if (step.runId !== runId) continue;
    const current = byId.get(step.id);
    if (current === undefined || step.updatedAt >= current.updatedAt) byId.set(step.id, step);
  }
  return [...byId.values()];
}

export type WorkflowStepPrompt =
  | { readonly kind: "ask"; readonly question: string; readonly choices: ReadonlyArray<string> }
  | { readonly kind: "gate" };

export interface WorkflowStepRow {
  readonly key: string;
  readonly title: string;
  /** 1 for one item of a parallel step. */
  readonly depth: 0 | 1;
  /** Latest attempt; null while the step has not started. */
  readonly step: CommandCenterWorkflowStep | null;
  /** What a waiting step asks the user: an ask's question (and choices), or a manual gate. */
  readonly waiting: WorkflowStepPrompt | null;
  /** Input for retryStep when the latest attempt failed or was stopped. */
  readonly retry: CommandCenterWorkflowRetryStepInput | null;
}

/**
 * One row per workflow node in file order, showing its latest attempt; a parallel node is
 * followed by one row per item. Nodes that only run inside a parallel node get no row of their own.
 */
export function workflowStepRows(
  workflow: CommandCenterWorkflow,
  steps: ReadonlyArray<CommandCenterWorkflowStep>,
): ReadonlyArray<WorkflowStepRow> {
  const latest = new Map<string, CommandCenterWorkflowStep>();
  const keyOf = (nodeId: string, item: number | null) =>
    item === null ? nodeId : `${nodeId}#${item}`;
  for (const step of steps) {
    const key = keyOf(step.nodeId, step.item);
    const current = latest.get(key);
    if (current === undefined || step.attempt > current.attempt) latest.set(key, step);
  }
  const nodes = new Map(workflow.nodes.map((node) => [node.id as string, node]));
  const bodies = new Set(
    workflow.nodes.flatMap((node) => (node.kind === "parallel" ? [node.node as string] : [])),
  );
  const retryOf = (step: CommandCenterWorkflowStep | null) =>
    step !== null && (step.status === "failed" || step.status === "stopped")
      ? {
          runId: step.runId,
          nodeId: step.nodeId,
          ...(step.item === null ? {} : { item: step.item }),
        }
      : null;

  const rows: WorkflowStepRow[] = [];
  for (const node of workflow.nodes) {
    if (bodies.has(node.id)) continue;
    const step = latest.get(node.id) ?? null;
    const waiting = step?.status === "waiting";
    rows.push({
      key: node.id,
      title: node.title ?? node.id,
      depth: 0,
      step,
      waiting: !waiting
        ? null
        : node.kind === "ask"
          ? { kind: "ask", question: node.question, choices: node.choices ?? [] }
          : node.kind === "gate" && node.check === "manual"
            ? { kind: "gate" }
            : null,
      retry: retryOf(step),
    });
    if (node.kind !== "parallel") continue;
    const body = nodes.get(node.node);
    const bodyTitle = body?.title ?? node.node;
    const items = [...latest.values()]
      .filter((child) => child.nodeId === node.node && child.item !== null)
      .sort((left, right) => (left.item ?? 0) - (right.item ?? 0));
    for (const child of items) {
      rows.push({
        key: keyOf(child.nodeId, child.item),
        title: `${bodyTitle} #${(child.item ?? 0) + 1}`,
        depth: 1,
        step: child,
        waiting: null,
        retry: retryOf(child),
      });
    }
  }
  return rows;
}
