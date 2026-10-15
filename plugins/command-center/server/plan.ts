// Plan to tasks: split one request into steps, create one task per step chained by dependsOn.
// The web imports splitRequest, so this file has type-only imports (no node code).
import type { Dispatcher } from "./dispatcher.ts";
import type { InteractionMode, ModelSelection, RuntimeMode, Task, TaskInput, TaskSource, WorkspaceStrategy } from "./types.ts";

// Commas, semicolons, new lines, and the connectives "and" / "y". An ordered "and then" / "y luego"
// is not split: that work stays in one step, in order. `\b` misses accented letters, so words are
// bounded by whitespace or the string ends.
const STEP_SEPARATOR = /[,;\n]|(?:^|\s+)(?:and|y)(?=\s|$)(?!\s+(?:then|luego)(?:\s|$))/giu;

/**
 * Splits a request into steps. Deterministic and free: no model call.
 * ponytail: naive split, so "search and replace" becomes two steps; the editable preview lets the
 * user merge them back. Upgrade path is an LLM splitter.
 */
export function splitRequest(request: string): string[] {
  return request
    .split(STEP_SEPARATOR)
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
}

export interface PlanStep {
  prompt: string;
  title?: string;
  /** Indexes of earlier steps this one waits for. Steps without any run in parallel. */
  after?: number[];
}

/** POST /api/plans body. Everything but steps applies to every step's task. */
export interface PlanInput {
  steps: PlanStep[];
  /** The original request; appended to each step as context when there is more than one. */
  request?: string;
  machineId: string;
  projectId: string;
  model?: ModelSelection | null;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  workspace?: WorkspaceStrategy;
  priority?: number;
  /** Existing tasks every step waits for (the shared dependencies). */
  dependsOn?: string[];
  profileId?: string;
}

export const MAX_STEPS = 12;
const CONTEXT_MAX = 4000;

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/**
 * Creates the plan's tasks in step order. If any task is rejected, the ones already created are
 * cancelled and the error is rethrown, so a plan is all or nothing. `prepare` adjusts each
 * step's input (the profile hook) before it reaches createTask.
 */
export async function createPlan(
  tasks: Pick<Dispatcher, "createTask" | "cancel">,
  input: PlanInput,
  source: TaskSource,
  prepare: (task: TaskInput) => TaskInput = (task) => task,
): Promise<Task[]> {
  const { steps, request, ...shared } = input;
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) throw new PlanError(`a plan has 1-${MAX_STEPS} steps`);
  steps.forEach((s, i) => {
    if (typeof s?.prompt !== "string" || !s.prompt.trim()) throw new PlanError(`step ${i + 1} is empty`);
    if (s.after !== undefined && (!Array.isArray(s.after) || s.after.some((j) => !Number.isInteger(j) || j < 0 || j >= i)))
      throw new PlanError(`step ${i + 1} can only wait for earlier steps`);
  });
  const context = steps.length > 1 && typeof request === "string" && request.trim() ? request.trim().slice(0, CONTEXT_MAX) : null;
  const created: Task[] = [];
  try {
    for (const [i, step] of steps.entries()) {
      const prompt = step.prompt.trim();
      const task = tasks.createTask(
        prepare({
          ...shared,
          prompt: context ? `${prompt}\n\nFull request, for context only:\n${context}` : prompt,
          title: step.title ?? prompt.split("\n")[0]!.slice(0, 60),
          dependsOn: [...new Set([...(shared.dependsOn ?? []), ...(step.after ?? []).map((j) => created[j]!.id)])],
        }),
        source,
      );
      created.push(task);
    }
  } catch (e) {
    for (const t of created) await tasks.cancel(t.id).catch(() => {});
    throw e;
  }
  return created;
}
