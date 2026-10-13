import {
  CommandCenterError,
  type CommandCenterTextRewriteInput,
  type CommandCenterTextRewriteResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { failWith } from "./CommandCenterService.ts";

export type TextRewriteKind = CommandCenterTextRewriteInput["kind"];

/** About 10k tokens: the most one click may spend on the cheap model. */
export const TEXT_REWRITE_MAX_CHARS = 40_000;

/**
 * "Rewrite shorter" for workflow prompts and skills: one call to the project's text generation
 * model (the one titles and branch names use), checked so placeholders survive and the result is
 * shorter. Only runs when the user asks; the client shows a diff before anything is saved.
 */
export class TextRewriter extends Context.Service<
  TextRewriter,
  {
    readonly rewrite: (
      input: CommandCenterTextRewriteInput,
    ) => Effect.Effect<CommandCenterTextRewriteResult, CommandCenterError>;
  }
>()("t3/commandCenter/TextRewriter") {}

const PLACEHOLDER = /\{\{[^{}]+\}\}/g;

export function buildRewritePrompt(kind: TextRewriteKind, text: string): string {
  const what =
    kind === "skill"
      ? "the instructions of a SKILL.md, which an AI coding agent loads when the skill applies"
      : "a prompt that an AI coding agent runs as one step of a workflow";
  return [
    `Rewrite ${what} so it uses as few tokens as possible.`,
    "Keep every instruction, constraint, name, path, command and example that changes what the agent does.",
    "Drop filler, repetition, pleasantries and restated context. Keep Markdown structure only where it helps.",
    "Copy every {{...}} placeholder exactly as written, for example {{input:name}}, {{snippet:name}} and {{item}}.",
    "Add nothing new. Write in the same language as the text.",
    'Reply with JSON only: {"text": "<the rewritten text>"}',
    "",
    "Text:",
    "<<<",
    text,
    ">>>",
  ].join("\n");
}

/** Why `after` cannot replace `before`, or null when it can. */
export function rewriteProblem(before: string, after: string): string | null {
  if (after.trim() === "") return "The text model returned nothing.";
  const kept = new Set(after.match(PLACEHOLDER) ?? []);
  const dropped = [...new Set(before.match(PLACEHOLDER) ?? [])].filter((ref) => !kept.has(ref));
  if (dropped.length > 0) return `The rewrite dropped ${dropped.join(", ")}. Try again.`;
  if (after.trim().length >= before.trim().length) return "The rewrite was not shorter.";
  return null;
}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const rewrite = Effect.fn("TextRewriter.rewrite")(function* (
    input: CommandCenterTextRewriteInput,
  ) {
    const text = input.text.trim();
    if (text === "")
      return yield* new CommandCenterError({ message: "There is no text to rewrite." });
    if (text.length > TEXT_REWRITE_MAX_CHARS) {
      return yield* new CommandCenterError({
        message: `Rewrite works on up to ${TEXT_REWRITE_MAX_CHARS.toLocaleString("en-US")} characters; split the text first.`,
      });
    }
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(failWith("Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* new CommandCenterError({
        message: "That project is not on this machine; ask the machine that has it.",
      });
    }
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failWith("Could not read the server settings.")),
    );
    const result = yield* textGeneration
      .rewriteText({
        cwd: project.value.workspaceRoot,
        prompt: buildRewritePrompt(input.kind, text),
        modelSelection: resolveProjectSettings(settings, input.projectId).settings
          .textGenerationModelSelection,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new CommandCenterError({
              message: `Could not rewrite the text: ${error.detail}`,
              cause: error,
            }),
        ),
      );
    const problem = rewriteProblem(text, result.text);
    if (problem !== null) return yield* new CommandCenterError({ message: problem });
    return { text: result.text.trim() };
  });

  return TextRewriter.of({ rewrite });
});

export const layer = Layer.effect(TextRewriter, make);
