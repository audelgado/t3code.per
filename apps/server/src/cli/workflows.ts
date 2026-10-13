import {
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowSlug,
  type CommandCenterWorkflowRun,
  type CommandCenterWorkflowStep,
  type CommandCenterWorkflowSummary,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import {
  CommandCenterCliError,
  type CommandCenterCliContext,
  printLines,
  projectFlag,
  withCommandCenter,
} from "./commandCenter.ts";
import { projectLocationFlags } from "./config.ts";

export const formatWorkflowLine = (workflow: CommandCenterWorkflowSummary) => {
  const inputs =
    workflow.inputs.length === 0
      ? ""
      : `  inputs: ${workflow.inputs.map((input) => input.name).join(", ")}`;
  const error = workflow.error === null ? "" : `  error: ${workflow.error}`;
  return `${workflow.slug}  ${workflow.title}  ${workflow.nodeCount} nodes${inputs}${error}`;
};

export const formatRunLine = (run: CommandCenterWorkflowRun) => {
  const error = run.error === null ? "" : `  ${run.error}`;
  return `${run.id}  ${run.slug}  ${run.status}  ${run.startedAt.slice(0, 16).replace("T", " ")}${error}`;
};

export const formatStepLine = (step: CommandCenterWorkflowStep) => {
  const item = step.item === null ? "" : `[${step.item}]`;
  const attempt = step.attempt > 1 ? ` (attempt ${step.attempt})` : "";
  const detail = step.error ?? step.output ?? "";
  return `  ${step.nodeId}${item}  ${step.status}${attempt}${detail === "" ? "" : `  ${detail.split("\n", 1)[0]}`}`;
};

const isSlug = Schema.is(CommandCenterWorkflowSlug);
const isRunId = Schema.is(CommandCenterWorkflowRunId);
const isNodeId = Schema.is(CommandCenterWorkflowNodeId);

const runIdArgument = Argument.String("runId").pipe(
  Argument.withDescription("Run id from `t3 wf run`."),
);

/** The trimmed run id, or a clean error for a blank one. */
const parseRunId = (
  raw: string,
): Effect.Effect<CommandCenterWorkflowRunId, CommandCenterCliError> => {
  const runId = raw.trim();
  return isRunId(runId)
    ? Effect.succeed(runId)
    : Effect.fail(new CommandCenterCliError({ message: `'${raw}' is not a run id.` }));
};

/** `--project`, or the project whose root is the current directory. */
const resolveProjectId = (context: CommandCenterCliContext, project: Option.Option<string>) =>
  context.resolveProject(Option.getOrElse(project, () => ".")).pipe(
    Effect.map((shell) => shell.id),
    Effect.mapError((error) =>
      Option.isNone(project)
        ? new CommandCenterCliError({
            message: "No project here; run it from a project's root folder or pass --project.",
            cause: error,
          })
        : error,
    ),
  );

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  project: projectFlag,
}).pipe(
  Command.withDescription("List the project's workflows (.t3/workflows)."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const projectId = yield* resolveProjectId(context, flags.project);
        const { workflows } = yield* context.rpc[WS_METHODS.commandCenterListWorkflows]({
          projectId,
        });
        yield* printLines(workflows.map(formatWorkflowLine), "No workflows in this project.");
      }),
    ),
  ),
);

const runCommand = Command.make("run", {
  ...projectLocationFlags,
  project: projectFlag,
  input: Flag.KeyValuePair("input").pipe(
    Flag.withDescription("A workflow input as name=value; repeat for more."),
    Flag.optional,
  ),
  slug: Argument.String("slug").pipe(Argument.withDescription("Workflow slug.")),
}).pipe(
  Command.withDescription("Start a run of a workflow."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const slug = flags.slug.trim();
        if (!isSlug(slug)) {
          return yield* new CommandCenterCliError({ message: `'${slug}' is not a workflow slug.` });
        }
        const projectId = yield* resolveProjectId(context, flags.project);
        const run = yield* context.rpc[WS_METHODS.commandCenterStartWorkflowRun]({
          projectId,
          slug,
          ...(Option.isSome(flags.input) ? { inputs: flags.input.value } : {}),
        });
        yield* Console.log(`Started ${formatRunLine(run)}`);
        yield* Console.log(`Follow it with: t3 wf status ${run.id}`);
      }),
    ),
  ),
);

const statusCommand = Command.make("status", {
  ...projectLocationFlags,
  runId: runIdArgument,
}).pipe(
  Command.withDescription("Show a workflow run and its steps."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      parseRunId(flags.runId).pipe(
        Effect.flatMap((runId) => context.rpc[WS_METHODS.commandCenterGetWorkflowRun]({ runId })),
        Effect.flatMap((detail) =>
          Console.log([formatRunLine(detail.run), ...detail.steps.map(formatStepLine)].join("\n")),
        ),
      ),
    ),
  ),
);

const answerCommand = Command.make("answer", {
  ...projectLocationFlags,
  runId: runIdArgument,
  nodeId: Argument.String("step").pipe(Argument.withDescription("The waiting step's id.")),
  answer: Argument.String("answer").pipe(
    Argument.withDescription("The answer (one of its choices), or a note on a gate."),
    Argument.optional,
  ),
  approve: Flag.Boolean("approve").pipe(
    Flag.withDescription("Pass a waiting manual gate."),
    Flag.withDefault(false),
  ),
  reject: Flag.Boolean("reject").pipe(
    Flag.withDescription("Fail a waiting manual gate."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Answer a run's waiting ask step, or --approve / --reject its gate."),
  Command.withHandler((flags) =>
    withCommandCenter(flags, (context) =>
      Effect.gen(function* () {
        const runId = yield* parseRunId(flags.runId);
        const nodeId = flags.nodeId.trim();
        if (!isNodeId(nodeId)) {
          return yield* new CommandCenterCliError({ message: `'${nodeId}' is not a step id.` });
        }
        if (flags.approve && flags.reject) {
          return yield* new CommandCenterCliError({
            message: "Pass --approve or --reject, not both.",
          });
        }
        const answer = Option.map(flags.answer, (text) => text.trim());
        const run = yield* context.rpc[WS_METHODS.commandCenterAnswerWorkflowStep]({
          runId,
          nodeId,
          ...(Option.isSome(answer) && answer.value !== "" ? { answer: answer.value } : {}),
          ...(flags.approve ? { approved: true } : flags.reject ? { approved: false } : {}),
        });
        yield* Console.log(formatRunLine(run));
      }),
    ),
  ),
);

export const workflowCommand = Command.make("wf").pipe(
  Command.withDescription(
    "List, run, follow and answer Command Center workflows on the running server.",
  ),
  Command.withSubcommands([listCommand, runCommand, statusCommand, answerCommand]),
);
