import { assert, describe, it } from "@effect/vitest";
import {
  type CommandCenterTextRewriteInput,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as TextRewriter from "./TextRewriter.ts";

const PROJECT = ProjectId.make("project-1");
const CHEAP: ModelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-mini" };
const LONG = "Please make sure that you always fix {{input:bug}} carefully and then report back.";

interface Call {
  readonly cwd: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
}

const layerWith = (reply: (call: Call) => Effect.Effect<{ text: string }, TextGenerationError>) =>
  TextRewriter.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({ rewriteText: reply }),
        ServerSettings.layerTest({ textGenerationModelSelection: CHEAP }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) =>
            Effect.succeed(
              id === PROJECT
                ? Option.some({
                    id: PROJECT,
                    title: "Test project",
                    workspaceRoot: "/repo",
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-10-01T00:00:00.000Z",
                    updatedAt: "2026-10-01T00:00:00.000Z",
                    deletedAt: null,
                  })
                : Option.none(),
            ),
        }),
      ),
    ),
  );

const rewrite = (input: CommandCenterTextRewriteInput) =>
  Effect.flatMap(TextRewriter.TextRewriter, (service) => service.rewrite(input));

describe("rewriteProblem", () => {
  it("accepts a shorter text that keeps every placeholder", () => {
    assert.isNull(TextRewriter.rewriteProblem(LONG, "Fix {{input:bug}}, then report."));
  });
  it("refuses empty, longer or placeholder-dropping rewrites", () => {
    assert.strictEqual(TextRewriter.rewriteProblem(LONG, "  "), "The text model returned nothing.");
    assert.strictEqual(
      TextRewriter.rewriteProblem(LONG, "Fix the bug."),
      "The rewrite dropped {{input:bug}}. Try again.",
    );
    assert.strictEqual(
      TextRewriter.rewriteProblem("Fix {{input:bug}}.", "Fix {{input:bug}} now."),
      "The rewrite was not shorter.",
    );
  });
});

describe("TextRewriter", () => {
  it.effect("asks the project's text generation model in the project folder", () => {
    const calls: Call[] = [];
    return rewrite({ projectId: PROJECT, kind: "prompt", text: `  ${LONG}  ` }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          assert.deepStrictEqual(result, { text: "Fix {{input:bug}}, then report." });
          assert.strictEqual(calls.length, 1);
          assert.strictEqual(calls[0]?.cwd, "/repo");
          assert.strictEqual(calls[0]?.modelSelection.model, CHEAP.model);
          assert.include(calls[0]?.prompt, `<<<\n${LONG}\n>>>`);
        }),
      ),
      Effect.provide(
        layerWith((call) => {
          calls.push(call);
          return Effect.succeed({ text: " Fix {{input:bug}}, then report.\n" });
        }),
      ),
    );
  });

  it.effect("explains each refusal", () =>
    Effect.gen(function* () {
      const message = (input: CommandCenterTextRewriteInput) =>
        rewrite(input).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.strictEqual(
        yield* message({ projectId: ProjectId.make("elsewhere"), kind: "skill", text: LONG }),
        "That project is not on this machine; ask the machine that has it.",
      );
      assert.strictEqual(
        yield* message({ projectId: PROJECT, kind: "prompt", text: " " }),
        "There is no text to rewrite.",
      );
      assert.strictEqual(
        yield* message({ projectId: PROJECT, kind: "prompt", text: LONG }),
        "The rewrite dropped {{input:bug}}. Try again.",
      );
    }).pipe(Effect.provide(layerWith(() => Effect.succeed({ text: "Fix it." })))),
  );

  it.effect("reports the provider's failure", () =>
    Effect.gen(function* () {
      const failed = yield* rewrite({ projectId: PROJECT, kind: "prompt", text: LONG }).pipe(
        Effect.flip,
        Effect.provide(
          layerWith(() =>
            Effect.fail(
              new TextGenerationError({ operation: "rewriteText", detail: "Rate limited." }),
            ),
          ),
        ),
      );
      assert.strictEqual(failed.message, "Could not rewrite the text: Rate limited.");
    }),
  );
});
