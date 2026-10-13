import {
  type CommandCenterWorkflow,
  type CommandCenterWorkflowInput,
  type CommandCenterWorkflowSlug,
  type CommandCenterWorkflowSummary,
  type KeybindingCommand,
  type ParsedWorkflowCommand,
  parseWorkflowCommand,
  planWorkflowInputs,
  WORKFLOW_RUN_COMMAND_PATTERN,
} from "@t3tools/contracts";
import { Schema } from "effect";

// `/wf <slug> [name=value]... [free text]` runs a Command Center workflow. Used by the
// orchestrator bar and the thread composer; the palette, keybindings and Run buttons skip
// straight to a slug. The parser lives in contracts, since scheduled task prompts use it too.

export { parseWorkflowCommand, planWorkflowInputs };
export type { ParsedWorkflowCommand };

/** A workflow a project can run: its own file, or a built-in starter it has not saved. */
export interface WorkflowChoice {
  readonly slug: CommandCenterWorkflowSlug;
  readonly title: string;
  readonly description: string;
  readonly inputs: ReadonlyArray<CommandCenterWorkflowInput>;
  /** Why the project's file cannot run; null when it can. */
  readonly error: string | null;
  /** Sent with the start request, since the project has no file for it. */
  readonly starter: CommandCenterWorkflow | null;
}

export function workflowChoices(
  saved: ReadonlyArray<CommandCenterWorkflowSummary>,
  starters: ReadonlyArray<CommandCenterWorkflow>,
): WorkflowChoice[] {
  const slugs = new Set<string>(saved.map((workflow) => workflow.slug));
  return [
    ...saved.map((workflow) => ({ ...workflow, starter: null })),
    ...starters
      .filter((starter) => !slugs.has(starter.slug))
      .map((starter) => ({
        slug: starter.slug,
        title: starter.title,
        description: starter.description,
        inputs: starter.inputs,
        error: null,
        starter,
      })),
  ];
}

export type WorkflowRunDecision =
  | { readonly kind: "blocked"; readonly title: string; readonly description: string | null }
  | {
      readonly kind: "run";
      readonly choice: WorkflowChoice;
      readonly inputs: Readonly<Record<string, string>>;
    }
  /** Ask in a dialog: something is missing, unknown or unclear. `slug` is "" when none matched. */
  | {
      readonly kind: "prompt";
      readonly slug: string;
      readonly values: Readonly<Record<string, string>>;
    };

/** What a run request does once the project's workflows are known. */
export function decideWorkflowRun(
  choices: ReadonlyArray<WorkflowChoice>,
  command: ParsedWorkflowCommand,
  options: { readonly canRun: boolean; readonly error: string | null },
): WorkflowRunDecision {
  if (!options.canRun) {
    return {
      kind: "blocked",
      title: "You cannot run workflows on this environment",
      description: null,
    };
  }
  if (choices.length === 0) {
    return {
      kind: "blocked",
      title: "No workflows to run",
      description: options.error ?? "Save one under .t3/workflows in this project.",
    };
  }
  const choice = choices.find((candidate) => candidate.slug === command.slug);
  if (!choice) return { kind: "prompt", slug: "", values: {} };
  const plan = planWorkflowInputs(choice.inputs, command);
  return choice.error === null &&
    plan.missing.length === 0 &&
    plan.unknown.length === 0 &&
    plan.leftover === ""
    ? { kind: "run", choice, inputs: plan.inputs }
    : { kind: "prompt", slug: choice.slug, values: plan.inputs };
}

export interface WorkflowCommandSuggestion {
  /** The whole text the input becomes. */
  readonly value: string;
  readonly label: string;
}

/** Completions for a draft: `/wf`, then a slug, then the input names not given yet. */
export function workflowCommandSuggestions(
  draft: string,
  choices: ReadonlyArray<WorkflowChoice>,
): WorkflowCommandSuggestion[] {
  const head = draft.trimStart();
  if (head !== "" && "/wf".startsWith(head.toLowerCase()) && head.length < 3) {
    return [{ value: "/wf ", label: "Run a workflow" }];
  }
  const command = parseWorkflowCommand(head);
  if (command === null) return [];
  if (/^\/wf(?:\s+\S*)?$/i.test(head)) {
    return choices
      .filter(
        (choice) =>
          choice.slug.startsWith(command.slug) || choice.title.toLowerCase().includes(command.slug),
      )
      .map((choice) => ({ value: `/wf ${choice.slug} `, label: choice.title }));
  }
  const choice = choices.find((candidate) => candidate.slug === command.slug);
  const partial = /\S*$/.exec(head)?.[0] ?? "";
  // Typing a value, or nothing left to name.
  if (!choice || /[="']/.test(partial)) return [];
  const base = head.slice(0, head.length - partial.length);
  return choice.inputs
    .filter(
      (input) =>
        !Object.hasOwn(command.inputs, input.name) &&
        input.name.toLowerCase().startsWith(partial.toLowerCase()),
    )
    .map((input) => ({
      value: `${base}${input.name}=`,
      label: input.default?.trim() ? `${input.label} (default ${input.default})` : input.label,
    }));
}

const isWorkflowRunCommand = Schema.is(WORKFLOW_RUN_COMMAND_PATTERN);

/** The keybinding command that runs this workflow; null for a slug it cannot carry. */
export function commandForWorkflow(slug: string): KeybindingCommand | null {
  const command = `workflow.${slug}.run`;
  return isWorkflowRunCommand(command) ? command : null;
}

export function workflowSlugFromCommand(command: string | null): string | null {
  if (command === null || !isWorkflowRunCommand(command)) return null;
  return command.slice("workflow.".length, -".run".length);
}
