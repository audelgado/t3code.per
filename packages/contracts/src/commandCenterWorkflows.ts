import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { CommandCenterAgentId } from "./commandCenter.ts";
import { ModelSelection } from "./modelSelection.ts";

// Command Center wave 5: workflows (docs/command-center/WORKFLOWS.md). A workflow is a file in
// the project, `.t3/workflows/<slug>.json`; snippets are `.t3/workflows/snippets/<name>.md`;
// skills are `SKILL.md` folders under `.agents/skills` mirrored to `.claude/skills`. The
// database only keeps runs. Prompts reference inputs as `{{input:name}}` and snippets as
// `{{snippet:name}}`.

/** Lowercase words joined by hyphens, safe as a file or folder name: `release-notes`. */
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Device names Windows will not let a file or folder use, whatever the extension. */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
const kebabName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(KEBAB_NAME),
  Schema.makeFilter((name: string) =>
    WINDOWS_RESERVED_NAME.test(name)
      ? `"${name}" is reserved on Windows; pick another name.`
      : true,
  ),
);

export const CommandCenterWorkflowSlug = kebabName.pipe(Schema.brand("CommandCenterWorkflowSlug"));
export type CommandCenterWorkflowSlug = typeof CommandCenterWorkflowSlug.Type;
export const CommandCenterSkillName = kebabName.pipe(Schema.brand("CommandCenterSkillName"));
export type CommandCenterSkillName = typeof CommandCenterSkillName.Type;
export const CommandCenterSnippetName = kebabName.pipe(Schema.brand("CommandCenterSnippetName"));
export type CommandCenterSnippetName = typeof CommandCenterSnippetName.Type;
export const CommandCenterWorkflowNodeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("CommandCenterWorkflowNodeId"));
export type CommandCenterWorkflowNodeId = typeof CommandCenterWorkflowNodeId.Type;
export const CommandCenterWorkflowRunId = TrimmedNonEmptyString.pipe(
  Schema.brand("CommandCenterWorkflowRunId"),
);
export type CommandCenterWorkflowRunId = typeof CommandCenterWorkflowRunId.Type;

const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const ShortText = TrimmedString.check(Schema.isMaxLength(2_000));
const Prompt = TrimmedString.check(Schema.isMaxLength(20_000));
const InputName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
);

export const CommandCenterWorkflowInput = Schema.Struct({
  /** Referenced in prompts as `{{input:name}}`. */
  name: InputName,
  label: Title,
  default: Schema.optionalKey(ShortText),
});
export type CommandCenterWorkflowInput = typeof CommandCenterWorkflowInput.Type;

const nodeBase = {
  id: CommandCenterWorkflowNodeId,
  /** Shown on the canvas; the id when omitted. */
  title: Schema.optionalKey(Title),
};

/** What an agent node leaves for the next nodes: a memory handoff, an artifact, or its reply. */
export const CommandCenterWorkflowOutput = Schema.Literals(["memory", "artifact", "text"]);
export type CommandCenterWorkflowOutput = typeof CommandCenterWorkflowOutput.Type;

export const CommandCenterWorkflowAgentNode = Schema.Struct({
  ...nodeBase,
  kind: Schema.Literal("agent"),
  /** A Command Center agent profile id, or an inline model. Omitted uses the server default. */
  profile: Schema.optionalKey(Schema.Union([CommandCenterAgentId, ModelSelection])),
  prompt: Prompt,
  skills: Schema.Array(CommandCenterSkillName)
    .check(Schema.isMaxLength(20))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Runs in its own worktree (projects with a Git remote). */
  worktree: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  outputs: CommandCenterWorkflowOutput.pipe(Schema.withDecodingDefaultKey(Effect.succeed("text"))),
});
export type CommandCenterWorkflowAgentNode = typeof CommandCenterWorkflowAgentNode.Type;

/** Runs one skill in a cheap agent. */
export const CommandCenterWorkflowSkillNode = Schema.Struct({
  ...nodeBase,
  kind: Schema.Literal("skill"),
  skill: CommandCenterSkillName,
  args: Schema.optionalKey(ShortText),
});
export type CommandCenterWorkflowSkillNode = typeof CommandCenterWorkflowSkillNode.Type;

/** Pauses the run for the user (pending input). */
export const CommandCenterWorkflowAskNode = Schema.Struct({
  ...nodeBase,
  kind: Schema.Literal("ask"),
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  choices: Schema.optionalKey(Schema.Array(Title).check(Schema.isMaxLength(10))),
});
export type CommandCenterWorkflowAskNode = typeof CommandCenterWorkflowAskNode.Type;

/**
 * Runs `node` (an agent or skill node with no edges of its own) once per item of `over`: an
 * input name, or the id of a node whose output is a list.
 */
export const CommandCenterWorkflowParallelNode = Schema.Struct({
  ...nodeBase,
  kind: Schema.Literal("parallel"),
  over: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  node: CommandCenterWorkflowNodeId,
});
export type CommandCenterWorkflowParallelNode = typeof CommandCenterWorkflowParallelNode.Type;

export const CommandCenterWorkflowGateCheck = Schema.Literals(["tests", "typecheck", "manual"]);
export type CommandCenterWorkflowGateCheck = typeof CommandCenterWorkflowGateCheck.Type;

/** Must pass for the run to continue. */
export const CommandCenterWorkflowGateNode = Schema.Struct({
  ...nodeBase,
  kind: Schema.Literal("gate"),
  check: CommandCenterWorkflowGateCheck,
});
export type CommandCenterWorkflowGateNode = typeof CommandCenterWorkflowGateNode.Type;

const NODE_SCHEMAS = {
  agent: CommandCenterWorkflowAgentNode,
  skill: CommandCenterWorkflowSkillNode,
  ask: CommandCenterWorkflowAskNode,
  parallel: CommandCenterWorkflowParallelNode,
  gate: CommandCenterWorkflowGateNode,
} as const;
export type CommandCenterWorkflowNodeKind = keyof typeof NODE_SCHEMAS;
export const COMMAND_CENTER_WORKFLOW_NODE_KINDS = Object.keys(
  NODE_SCHEMAS,
) as ReadonlyArray<CommandCenterWorkflowNodeKind>;

export const CommandCenterWorkflowNode = Schema.Union([
  CommandCenterWorkflowAgentNode,
  CommandCenterWorkflowSkillNode,
  CommandCenterWorkflowAskNode,
  CommandCenterWorkflowParallelNode,
  CommandCenterWorkflowGateNode,
]);
export type CommandCenterWorkflowNode = typeof CommandCenterWorkflowNode.Type;

export const CommandCenterWorkflowEdge = Schema.Struct({
  from: CommandCenterWorkflowNodeId,
  to: CommandCenterWorkflowNodeId,
});
export type CommandCenterWorkflowEdge = typeof CommandCenterWorkflowEdge.Type;

const Coordinate = Schema.Int.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));

/** Most nodes one workflow holds; the editor canvas is not virtualized. */
export const COMMAND_CENTER_WORKFLOW_NODE_LIMIT = 100;

/** The contents of `.t3/workflows/<slug>.json`. Run `validateCommandCenterWorkflow` for the graph. */
export const CommandCenterWorkflow = Schema.Struct({
  slug: CommandCenterWorkflowSlug,
  title: Title,
  description: ShortText.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  inputs: Schema.Array(CommandCenterWorkflowInput)
    .check(Schema.isMaxLength(20))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  nodes: Schema.Array(CommandCenterWorkflowNode).check(
    Schema.isMaxLength(COMMAND_CENTER_WORKFLOW_NODE_LIMIT),
  ),
  edges: Schema.Array(CommandCenterWorkflowEdge)
    .check(Schema.isMaxLength(500))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Canvas position per node id; entries for missing nodes are dropped on save. */
  layout: Schema.Record(Schema.String, Schema.Struct({ x: Coordinate, y: Coordinate })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});
export type CommandCenterWorkflow = typeof CommandCenterWorkflow.Type;

const INPUT_REFERENCE = /\{\{input:([^}]*)\}\}/g;

const nodeTexts = (node: CommandCenterWorkflowNode) =>
  node.kind === "agent"
    ? [node.prompt]
    : node.kind === "skill"
      ? [node.args ?? ""]
      : node.kind === "ask"
        ? [node.question]
        : [];

/**
 * Graph problems of a decoded workflow, as sentences an agent can act on: repeated ids or input
 * names, edges to missing nodes, self or repeated edges, cycles, misused parallel bodies and
 * `{{input:name}}` references to undeclared inputs. Empty when the workflow can run.
 */
export function validateCommandCenterWorkflow(workflow: CommandCenterWorkflow): string[] {
  const errors: string[] = [];
  const nodes = new Map<string, CommandCenterWorkflowNode>();
  for (const node of workflow.nodes) {
    if (nodes.has(node.id)) errors.push(`Node id "${node.id}" is used more than once.`);
    else nodes.set(node.id, node);
  }
  const inputs = new Set<string>();
  for (const input of workflow.inputs) {
    if (inputs.has(input.name)) errors.push(`Input "${input.name}" is declared more than once.`);
    inputs.add(input.name);
  }

  const outgoing = new Map<string, string[]>();
  const touched = new Set<string>();
  const seenEdges = new Set<string>();
  for (const { from, to } of workflow.edges) {
    if (!nodes.has(from) || !nodes.has(to)) {
      errors.push(`Edge from "${from}" to "${to}" points at a missing node.`);
      continue;
    }
    if (from === to) {
      errors.push(`Edge from "${from}" to itself.`);
      continue;
    }
    const key = `${from}\u0000${to}`;
    if (seenEdges.has(key)) {
      errors.push(`Edge from "${from}" to "${to}" is listed twice.`);
      continue;
    }
    seenEdges.add(key);
    touched.add(from).add(to);
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }

  const bodies = new Map<string, string>();
  for (const node of nodes.values()) {
    if (node.kind !== "parallel") continue;
    const body = nodes.get(node.node);
    if (body === undefined) {
      errors.push(`Parallel node "${node.id}" runs "${node.node}", which is not a node.`);
    } else if (body.kind !== "agent" && body.kind !== "skill") {
      errors.push(`Parallel node "${node.id}" can only run an agent or skill node.`);
    } else if (bodies.has(body.id)) {
      errors.push(`Node "${body.id}" is run by both "${bodies.get(body.id)}" and "${node.id}".`);
    } else {
      bodies.set(body.id, node.id);
      if (touched.has(body.id)) {
        errors.push(
          `Node "${body.id}" runs inside "${node.id}", so it cannot have edges; connect "${node.id}" instead.`,
        );
      }
    }
    if (!inputs.has(node.over) && (!nodes.has(node.over) || node.over === node.id)) {
      errors.push(
        `Parallel node "${node.id}" runs over "${node.over}", which is neither an input nor another node.`,
      );
    }
  }
  for (const node of nodes.values()) {
    if (node.kind !== "parallel" || inputs.has(node.over) || !nodes.has(node.over)) continue;
    if (bodies.has(node.over)) {
      errors.push(
        `Parallel node "${node.id}" runs over "${node.over}", which runs inside "${bodies.get(node.over)}"; use "${bodies.get(node.over)}" instead.`,
      );
    } else if (node.over !== node.id) {
      // A parallel node waits for the node it runs over, like an edge into it.
      outgoing.set(node.over, [...(outgoing.get(node.over) ?? []), node.id]);
    }
  }

  // Depth-first search; a node met again while still on the path closes a cycle.
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "open");
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      if (state.get(next) === "open") return [...path.slice(path.indexOf(next)), next];
      if (state.get(next) === undefined) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    path.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of nodes.keys()) {
    if (state.has(id)) continue;
    const cycle = visit(id);
    if (cycle) {
      errors.push(`The edges form a cycle: ${cycle.join(" -> ")}.`);
      break;
    }
  }

  for (const node of nodes.values()) {
    for (const text of nodeTexts(node)) {
      for (const [, name] of text.matchAll(INPUT_REFERENCE)) {
        if (name !== undefined && !inputs.has(name)) {
          errors.push(`Node "${node.id}" uses {{input:${name}}}, which is not declared in inputs.`);
        }
      }
    }
  }
  return errors;
}

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, " ");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeWorkflow = Schema.decodeUnknownSync(CommandCenterWorkflow);
const decodeNode = Object.fromEntries(
  Object.entries(NODE_SCHEMAS).map(([kind, schema]) => [kind, Schema.decodeUnknownSync(schema)]),
) as Record<CommandCenterWorkflowNodeKind, (value: unknown) => unknown>;

export interface CommandCenterWorkflowParseResult {
  /** Null when `errors` is not empty. */
  readonly workflow: CommandCenterWorkflow | null;
  readonly errors: ReadonlyArray<string>;
}

/**
 * Reads a workflow file's parsed JSON: every node is checked on its own (so a bad node names
 * itself, and an unknown `kind` says which kinds exist), then the whole file, then the graph.
 */
export function parseCommandCenterWorkflow(raw: unknown): CommandCenterWorkflowParseResult {
  if (!isRecord(raw)) return { workflow: null, errors: ["A workflow is a JSON object."] };
  const errors: string[] = [];
  const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  nodes.forEach((node, index) => {
    const label = isRecord(node) && typeof node.id === "string" ? `"${node.id}"` : `#${index + 1}`;
    const kind = isRecord(node) ? node.kind : undefined;
    if (typeof kind !== "string" || !Object.hasOwn(NODE_SCHEMAS, kind)) {
      errors.push(
        `Node ${label} has unknown kind ${JSON.stringify(kind ?? null)}; use ${COMMAND_CENTER_WORKFLOW_NODE_KINDS.join(", ")}.`,
      );
      return;
    }
    try {
      decodeNode[kind as CommandCenterWorkflowNodeKind](node);
    } catch (error) {
      errors.push(`Node ${label}: ${errorText(error)}`);
    }
  });
  if (errors.length > 0) return { workflow: null, errors };
  let workflow: CommandCenterWorkflow;
  try {
    workflow = decodeWorkflow(raw);
  } catch (error) {
    return { workflow: null, errors: [errorText(error)] };
  }
  const graphErrors = validateCommandCenterWorkflow(workflow);
  return graphErrors.length > 0
    ? { workflow: null, errors: graphErrors }
    : { workflow, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// Library (files)

const ProjectInput = { projectId: ProjectId };

export const CommandCenterWorkflowSummary = Schema.Struct({
  slug: CommandCenterWorkflowSlug,
  /** The slug when the file cannot be read. */
  title: Title,
  description: ShortText,
  inputs: Schema.Array(CommandCenterWorkflowInput),
  nodeCount: NonNegativeInt,
  /** File modification time. */
  updatedAt: IsoDateTime,
  /** Why the file cannot be used (bad JSON, schema or graph); null when it can. */
  error: Schema.NullOr(Schema.String),
});
export type CommandCenterWorkflowSummary = typeof CommandCenterWorkflowSummary.Type;

export const CommandCenterWorkflowListInput = Schema.Struct({
  ...ProjectInput,
  /** True lists deleted workflows (kept in `.t3/workflows/.trash`), which restore brings back. */
  trashed: Schema.optional(Schema.Boolean),
});
export type CommandCenterWorkflowListInput = typeof CommandCenterWorkflowListInput.Type;

/** By slug. Re-sent by the subscription whenever a workflow file changes, on disk or here. */
export const CommandCenterWorkflowListResult = Schema.Struct({
  workflows: Schema.Array(CommandCenterWorkflowSummary),
});
export type CommandCenterWorkflowListResult = typeof CommandCenterWorkflowListResult.Type;

export const CommandCenterWorkflowRef = Schema.Struct({
  ...ProjectInput,
  slug: CommandCenterWorkflowSlug,
});
export type CommandCenterWorkflowRef = typeof CommandCenterWorkflowRef.Type;

/** A workflow file, or, when it cannot be used, its errors and raw text so it can be fixed. */
export const CommandCenterWorkflowDetail = Schema.Struct({
  slug: CommandCenterWorkflowSlug,
  workflow: Schema.NullOr(CommandCenterWorkflow),
  errors: Schema.Array(Schema.String),
  /** The file's text; only when `workflow` is null. */
  raw: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type CommandCenterWorkflowDetail = typeof CommandCenterWorkflowDetail.Type;

/** Validates, then writes `.t3/workflows/<workflow.slug>.json` (replacing it). */
export const CommandCenterWorkflowSaveInput = Schema.Struct({
  ...ProjectInput,
  workflow: CommandCenterWorkflow,
});
export type CommandCenterWorkflowSaveInput = typeof CommandCenterWorkflowSaveInput.Type;

/** Built-in workflows a user can copy into a project (save one under the project). */
export const CommandCenterWorkflowStarters = Schema.Struct({
  starters: Schema.Array(CommandCenterWorkflow),
});
export type CommandCenterWorkflowStarters = typeof CommandCenterWorkflowStarters.Type;

const SnippetContent = Schema.String.check(Schema.isMaxLength(20_000));

export const CommandCenterSnippetSummary = Schema.Struct({
  name: CommandCenterSnippetName,
  /** Characters; a token estimate is about a quarter of it. */
  chars: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type CommandCenterSnippetSummary = typeof CommandCenterSnippetSummary.Type;

export const CommandCenterSnippetListInput = Schema.Struct(ProjectInput);
export type CommandCenterSnippetListInput = typeof CommandCenterSnippetListInput.Type;

export const CommandCenterSnippetListResult = Schema.Struct({
  snippets: Schema.Array(CommandCenterSnippetSummary),
});
export type CommandCenterSnippetListResult = typeof CommandCenterSnippetListResult.Type;

export const CommandCenterSnippetRef = Schema.Struct({
  ...ProjectInput,
  name: CommandCenterSnippetName,
});
export type CommandCenterSnippetRef = typeof CommandCenterSnippetRef.Type;

export const CommandCenterSnippet = Schema.Struct({
  name: CommandCenterSnippetName,
  content: SnippetContent,
  updatedAt: IsoDateTime,
});
export type CommandCenterSnippet = typeof CommandCenterSnippet.Type;

export const CommandCenterSnippetSaveInput = Schema.Struct({
  ...ProjectInput,
  name: CommandCenterSnippetName,
  content: SnippetContent,
});
export type CommandCenterSnippetSaveInput = typeof CommandCenterSnippetSaveInput.Type;

export const CommandCenterSkillSummary = Schema.Struct({
  name: CommandCenterSkillName,
  description: Schema.NullOr(Schema.String),
  /** Has `.agents/skills/<name>/SKILL.md` (Codex, Antigravity). */
  inAgents: Schema.Boolean,
  /** Has `.claude/skills/<name>/SKILL.md` (Claude). */
  inClaude: Schema.Boolean,
});
export type CommandCenterSkillSummary = typeof CommandCenterSkillSummary.Type;

export const CommandCenterSkillListInput = Schema.Struct(ProjectInput);
export type CommandCenterSkillListInput = typeof CommandCenterSkillListInput.Type;

/** The project's own skills, by name. */
export const CommandCenterSkillListResult = Schema.Struct({
  skills: Schema.Array(CommandCenterSkillSummary),
});
export type CommandCenterSkillListResult = typeof CommandCenterSkillListResult.Type;

/**
 * Writes `SKILL.md` (frontmatter `name` and `description`, then `content`) to
 * `.agents/skills/<name>/` and mirrors it to `.claude/skills/<name>/`, so every provider sees it.
 * Create refuses an existing name; update refuses a missing one and replaces both copies.
 */
export const CommandCenterSkillWriteInput = Schema.Struct({
  ...ProjectInput,
  name: CommandCenterSkillName,
  /** When to use the skill; providers show it to the model, so keep it to a sentence or two. */
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
  /** Markdown instructions. */
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
});
export type CommandCenterSkillWriteInput = typeof CommandCenterSkillWriteInput.Type;

export const CommandCenterSkillWriteResult = Schema.Struct({ skill: CommandCenterSkillSummary });
export type CommandCenterSkillWriteResult = typeof CommandCenterSkillWriteResult.Type;

/** A skill by name; delete moves both copies to `.t3/workflows/.trash/skills`, restore brings them back. */
export const CommandCenterSkillRef = Schema.Struct({
  ...ProjectInput,
  name: CommandCenterSkillName,
});
export type CommandCenterSkillRef = typeof CommandCenterSkillRef.Type;

/** "Rewrite shorter": one call to the project's text generation model. */
export const CommandCenterTextRewriteInput = Schema.Struct({
  ...ProjectInput,
  kind: Schema.Literals(["prompt", "skill"]),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(40_000)),
});
export type CommandCenterTextRewriteInput = typeof CommandCenterTextRewriteInput.Type;

export const CommandCenterTextRewriteResult = Schema.Struct({ text: Schema.String });
export type CommandCenterTextRewriteResult = typeof CommandCenterTextRewriteResult.Type;

// ---------------------------------------------------------------------------------------------
// Runs (SQLite `cc_workflow_runs` / `cc_workflow_steps`, on the Command Center home)

export const CommandCenterWorkflowRunStatus = Schema.Literals([
  "queued",
  "running",
  /** An `ask` or manual gate is waiting for the user. */
  "waiting",
  "succeeded",
  "failed",
  "stopped",
]);
export type CommandCenterWorkflowRunStatus = typeof CommandCenterWorkflowRunStatus.Type;

export const CommandCenterWorkflowStepStatus = Schema.Literals([
  "pending",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "skipped",
  "stopped",
]);
export type CommandCenterWorkflowStepStatus = typeof CommandCenterWorkflowStepStatus.Type;

const RunInputs = Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(20_000)));

export const CommandCenterWorkflowRun = Schema.Struct({
  id: CommandCenterWorkflowRunId,
  slug: CommandCenterWorkflowSlug,
  title: Title,
  projectId: ProjectId,
  /** Where the project lives and the run's threads start. */
  environmentId: EnvironmentId,
  status: CommandCenterWorkflowRunStatus,
  inputs: RunInputs,
  error: Schema.NullOr(ShortText),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type CommandCenterWorkflowRun = typeof CommandCenterWorkflowRun.Type;

export const CommandCenterWorkflowStep = Schema.Struct({
  /** Unique per run, node, fan-out item and attempt. */
  id: TrimmedNonEmptyString,
  runId: CommandCenterWorkflowRunId,
  nodeId: CommandCenterWorkflowNodeId,
  /** Fan-out position under a parallel node; null otherwise. */
  item: Schema.NullOr(NonNegativeInt),
  /** Retrying a step adds an attempt. */
  attempt: PositiveInt,
  threadId: Schema.NullOr(ThreadId),
  status: CommandCenterWorkflowStepStatus,
  /** Short result handed on (an answer, a memory or artifact id, a clipped reply). */
  output: Schema.NullOr(ShortText),
  error: Schema.NullOr(ShortText),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type CommandCenterWorkflowStep = typeof CommandCenterWorkflowStep.Type;

/** A run with every step and the workflow as it was when the run started. */
export const CommandCenterWorkflowRunDetail = Schema.Struct({
  run: CommandCenterWorkflowRun,
  steps: Schema.Array(CommandCenterWorkflowStep),
  workflow: CommandCenterWorkflow,
});
export type CommandCenterWorkflowRunDetail = typeof CommandCenterWorkflowRunDetail.Type;

export const CommandCenterWorkflowRunStartInput = Schema.Struct({
  ...ProjectInput,
  slug: CommandCenterWorkflowSlug,
  /** By input name; declared inputs left out take their default. */
  inputs: Schema.optional(RunInputs),
  /** Where the project lives; this server when omitted. */
  environmentId: Schema.optional(EnvironmentId),
  /**
   * The workflow to run, for a project on another environment (read it there first). Omitted,
   * this server reads `.t3/workflows/<slug>.json` from the project.
   */
  workflow: Schema.optional(CommandCenterWorkflow),
});
export type CommandCenterWorkflowRunStartInput = typeof CommandCenterWorkflowRunStartInput.Type;

export const CommandCenterWorkflowRunRef = Schema.Struct({ runId: CommandCenterWorkflowRunId });
export type CommandCenterWorkflowRunRef = typeof CommandCenterWorkflowRunRef.Type;

/** Runs one failed or stopped step again (a fan-out child by `item`) and continues the run. */
export const CommandCenterWorkflowRetryStepInput = Schema.Struct({
  runId: CommandCenterWorkflowRunId,
  nodeId: CommandCenterWorkflowNodeId,
  item: Schema.optional(NonNegativeInt),
});
export type CommandCenterWorkflowRetryStepInput = typeof CommandCenterWorkflowRetryStepInput.Type;

/**
 * Answers a waiting `ask` (with choices, the first continues the run and any other stops it
 * there), or approves (`approved: true`) or rejects a waiting manual gate, with `answer` as a note.
 */
export const CommandCenterWorkflowAnswerStepInput = Schema.Struct({
  runId: CommandCenterWorkflowRunId,
  nodeId: CommandCenterWorkflowNodeId,
  answer: Schema.optional(ShortText),
  approved: Schema.optional(Schema.Boolean),
});
export type CommandCenterWorkflowAnswerStepInput = typeof CommandCenterWorkflowAnswerStepInput.Type;

const RunFilterFields = {
  /** Omit for every project. */
  projectId: Schema.optional(ProjectId),
};

/** One page, newest first. */
export const CommandCenterWorkflowRunListInput = Schema.Struct({
  ...RunFilterFields,
  slug: Schema.optional(CommandCenterWorkflowSlug),
  /** Only runs started before this one (the last row of the previous page). */
  before: Schema.optional(CommandCenterWorkflowRunId),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type CommandCenterWorkflowRunListInput = typeof CommandCenterWorkflowRunListInput.Type;

export const CommandCenterWorkflowRunListResult = Schema.Struct({
  runs: Schema.Array(CommandCenterWorkflowRun),
  hasMore: Schema.Boolean,
});
export type CommandCenterWorkflowRunListResult = typeof CommandCenterWorkflowRunListResult.Type;

export const CommandCenterWorkflowRunSubscribeInput = Schema.Struct(RunFilterFields);
export type CommandCenterWorkflowRunSubscribeInput =
  typeof CommandCenterWorkflowRunSubscribeInput.Type;

/** What a client keeps from `subscribeWorkflowRuns`: the newest runs first, with their steps. */
export interface CommandCenterWorkflowRunsState {
  readonly runs: ReadonlyArray<CommandCenterWorkflowRun>;
  readonly steps: ReadonlyArray<CommandCenterWorkflowStep>;
}

/** Newest runs shown on subscribe (older ones page in through `listWorkflowRuns`). */
export const COMMAND_CENTER_WORKFLOW_RUN_SNAPSHOT_LIMIT = 50;

/**
 * `subscribeWorkflowRuns`: one `snapshot` (the newest runs, plus the steps of the unfinished
 * ones), then a `run` or `step` row for every change.
 */
export const CommandCenterWorkflowRunStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    runs: Schema.Array(CommandCenterWorkflowRun),
    steps: Schema.Array(CommandCenterWorkflowStep),
  }),
  Schema.Struct({ type: Schema.Literal("run"), run: CommandCenterWorkflowRun }),
  Schema.Struct({ type: Schema.Literal("step"), step: CommandCenterWorkflowStep }),
]);
export type CommandCenterWorkflowRunStreamEvent = typeof CommandCenterWorkflowRunStreamEvent.Type;

// ---------------------------------------------------------------------------------------------
// `/wf <slug> [name=value]... [free text]`: the orchestrator bar, the thread composer and
// scheduled task prompts run a workflow with it.

export interface ParsedWorkflowCommand {
  /** As typed, lowercased; empty while only `/wf` is typed. */
  readonly slug: string;
  /** `name=value` pairs; a value with spaces is quoted: `bug="login fails"`. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Everything else, for the first input still without a value. */
  readonly text: string;
}

const WF_PREFIX = /^\/wf(?=\s|$)/i;
const WF_TOKEN = /([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))|(\S+)/g;

export function parseWorkflowCommand(text: string): ParsedWorkflowCommand | null {
  const trimmed = text.trim();
  const prefix = WF_PREFIX.exec(trimmed);
  if (!prefix) return null;
  const rest = trimmed.slice(prefix[0].length).trimStart();
  const slug = /^\S*/.exec(rest)?.[0] ?? "";
  const entries: Array<[string, string]> = [];
  const words: string[] = [];
  for (const match of rest.slice(slug.length).matchAll(WF_TOKEN)) {
    const [, name, doubleQuoted, singleQuoted, bare, word] = match;
    if (name !== undefined) entries.push([name, doubleQuoted ?? singleQuoted ?? bare ?? ""]);
    else if (word !== undefined) words.push(word);
  }
  return {
    slug: slug.toLowerCase(),
    // fromEntries defines own keys, so an input named `__proto__` stays a plain value.
    inputs: Object.fromEntries(entries),
    text: words.join(" ").replace(/^"(.*)"$/s, "$1"),
  };
}

export interface WorkflowInputPlan {
  /** Values given or taken from the free text, by input name. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Inputs with no value and no default; the run needs them. */
  readonly missing: ReadonlyArray<string>;
  /** `name=value` pairs the workflow does not declare. */
  readonly unknown: ReadonlyArray<string>;
  /** Free text no input could take. */
  readonly leftover: string;
}

/**
 * Matches a parsed command to a workflow's inputs. Free text goes to the first input still
 * without a value, preferring one with no default, so `/wf bugfix login fails` fills `bug`.
 */
export function planWorkflowInputs(
  declared: ReadonlyArray<CommandCenterWorkflowInput>,
  command: Pick<ParsedWorkflowCommand, "inputs" | "text">,
): WorkflowInputPlan {
  const names = new Set(declared.map((input) => input.name));
  const unknown = Object.keys(command.inputs).filter((name) => !names.has(name));
  const values = new Map<string, string>();
  for (const input of declared) {
    const value = Object.hasOwn(command.inputs, input.name)
      ? command.inputs[input.name]?.trim()
      : undefined;
    if (value) values.set(input.name, value);
  }
  let leftover = command.text.trim();
  if (leftover !== "") {
    const open = declared.filter((input) => !values.has(input.name));
    const target = open.find((input) => !input.default?.trim()) ?? open[0];
    if (target) {
      values.set(target.name, leftover);
      leftover = "";
    }
  }
  return {
    inputs: Object.fromEntries(values),
    missing: declared
      .filter((input) => !values.has(input.name) && !input.default?.trim())
      .map((input) => input.name),
    unknown,
    leftover,
  };
}
