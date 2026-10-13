import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandCenterSkillName,
  CommandCenterSnippetName,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowSlug,
  EnvironmentId,
  parseCommandCenterWorkflow,
  ProjectId,
  type CommandCenterWorkflow,
  type CommandCenterWorkflowRun,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as CommandCenterService from "./CommandCenterService.ts";
import { layerTest } from "./CommandCenterService.testkit.ts";
import * as SkillWriter from "./SkillWriter.ts";
import * as WorkflowRunner from "./WorkflowRunner.ts";
import { WORKFLOW_STARTER_FILES, WORKFLOW_STARTERS } from "./workflowStarters.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const projectId = ProjectId.make("project:workflows");
const slug = CommandCenterWorkflowSlug.make("feature");
const plan = CommandCenterWorkflowNodeId.make("plan");
const build = CommandCenterWorkflowNodeId.make("build");

const feature: CommandCenterWorkflow = {
  slug,
  title: "Feature",
  description: "",
  inputs: [{ name: "feature", label: "Feature" }],
  nodes: [
    {
      id: plan,
      kind: "agent",
      prompt: "Plan {{input:feature}}",
      skills: [],
      worktree: false,
      outputs: "text",
    },
    { id: build, kind: "agent", prompt: "Build it", skills: [], worktree: true, outputs: "text" },
  ],
  edges: [{ from: plan, to: build }],
  layout: { plan: { x: 0, y: 0 }, gone: { x: 5, y: 5 } },
};

type ProjectServices =
  | WorkflowStore.WorkflowStore
  | SkillWriter.SkillWriter
  | FileSystem.FileSystem
  | Path.Path;

/** Runs `test` against a temporary project folder registered as `projectId`. */
const inProject = <A, E>(test: (root: string) => Effect.Effect<A, E, ProjectServices>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cc-workflows-" });
    // Not a layer on the test: layers are memoized per test, and this one needs the folder.
    return yield* test(root).pipe(Effect.provide(layerTest({ projects: { [projectId]: root } })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("saves, lists, deletes and restores workflow files", () =>
  inProject((root) =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const folder = path.join(root, ".t3", "workflows");

      const saved = yield* store.save({ projectId, workflow: feature });
      assert.deepStrictEqual(saved.workflow?.layout, { plan: { x: 0, y: 0 } });
      const text = yield* fs.readFileString(path.join(folder, "feature.json"));
      assert.include(text, '\n  "slug": "feature"');

      yield* fs.writeFileString(path.join(folder, "broken.json"), "{ nope");
      const listed = yield* store.list({ projectId });
      expect(listed.workflows).toMatchObject([
        { slug: "broken", title: "broken", nodeCount: 0 },
        { slug: "feature", title: "Feature", nodeCount: 2, error: null },
      ]);
      assert.match(listed.workflows[0]?.error ?? "", /^Invalid JSON/);
      const broken = yield* store.get({
        projectId,
        slug: CommandCenterWorkflowSlug.make("broken"),
      });
      assert.isNull(broken.workflow);
      assert.strictEqual(broken.raw, "{ nope");

      const cycle = yield* store
        .save({
          projectId,
          workflow: { ...feature, edges: [...feature.edges, { from: build, to: plan }] },
        })
        .pipe(Effect.flip);
      assert.include(cycle.message, "cycle");

      yield* store.remove({ projectId, slug });
      assert.deepStrictEqual(
        (yield* store.list({ projectId })).workflows.map((workflow) => workflow.slug),
        ["broken"],
      );
      assert.deepStrictEqual(
        (yield* store.list({ projectId, trashed: true })).workflows.map(
          (workflow) => workflow.slug,
        ),
        ["feature"],
      );
      assert.strictEqual((yield* store.restore({ projectId, slug })).title, "Feature");
      const again = yield* store.restore({ projectId, slug }).pipe(Effect.flip);
      assert.include(again.message, "already exists");
      const missing = yield* store
        .get({ projectId, slug: CommandCenterWorkflowSlug.make("nothing") })
        .pipe(Effect.flip);
      assert.strictEqual(missing.message, 'No workflow named "nothing".');
    }),
  ),
);

// Live clock: the re-list waits out the watcher debounce (150ms), which a test clock would hold.
it.live("re-sends the list to subscribers after a save", () =>
  inProject(() =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const first = yield* Deferred.make<void>();
      const fiber = yield* store.subscribe({ projectId }).pipe(
        Stream.tap(() => Deferred.succeed(first, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(first);
      yield* store.save({ projectId, workflow: feature });
      const lists = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        lists.map((list) => list.workflows.map((workflow) => workflow.slug)),
        [[], ["feature"]],
      );
    }),
  ),
);

it.effect("saves, reads, deletes and restores snippets", () =>
  inProject(() =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const name = CommandCenterSnippetName.make("house-rules");
      yield* store.saveSnippet({ projectId, name, content: "Write tests first." });
      expect((yield* store.listSnippets({ projectId })).snippets).toMatchObject([
        { name, chars: 18 },
      ]);
      assert.strictEqual(
        (yield* store.getSnippet({ projectId, name })).content,
        "Write tests first.",
      );

      yield* store.deleteSnippet({ projectId, name });
      expect((yield* store.listSnippets({ projectId })).snippets).toEqual([]);
      assert.strictEqual(
        (yield* store.deleteSnippet({ projectId, name }).pipe(Effect.flip)).message,
        'No snippet named "house-rules".',
      );
      expect(yield* store.restoreSnippet({ projectId, name })).toMatchObject({ name, chars: 18 });
      assert.strictEqual(
        (yield* store.restoreSnippet({ projectId, name }).pipe(Effect.flip)).message,
        'A snippet named "house-rules" already exists; delete it first.',
      );
    }),
  ),
);

it.effect("writes skills to both provider folders", () =>
  inProject((root) =>
    Effect.gen(function* () {
      const skills = yield* SkillWriter.SkillWriter;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = CommandCenterSkillName.make("release-notes");
      const input = {
        projectId,
        name,
        description: "Use when writing release notes: groups changes for users.",
        content: "# Release notes\n\nGroup by feature.",
      };

      const created = yield* skills.create(input);
      expect(created.skill).toEqual({
        name,
        description: input.description,
        inAgents: true,
        inClaude: true,
      });
      const claudeCopy = yield* fs.readFileString(
        path.join(root, ".claude", "skills", name, "SKILL.md"),
      );
      assert.strictEqual(
        claudeCopy,
        yield* fs.readFileString(path.join(root, ".agents", "skills", name, "SKILL.md")),
      );
      assert.match(claudeCopy, /^---\nname: release-notes\ndescription: "Use when/);
      assert.include((yield* skills.create(input).pipe(Effect.flip)).message, "already exists");

      yield* skills.update({ ...input, description: "Updated." });
      // A skill only one provider has still lists, and an update brings both back in line.
      yield* fs.makeDirectory(path.join(root, ".claude", "skills", "solo"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".claude", "skills", "solo", "SKILL.md"),
        "---\nname: solo\ndescription: Solo skill.\n---\n\nBody\n",
      );
      expect((yield* skills.list({ projectId })).skills).toEqual([
        { name, description: "Updated.", inAgents: true, inClaude: true },
        { name: "solo", description: "Solo skill.", inAgents: false, inClaude: true },
      ]);
      const missing = yield* skills
        .update({ ...input, name: CommandCenterSkillName.make("nothing") })
        .pipe(Effect.flip);
      assert.strictEqual(missing.message, 'No skill named "nothing".');
    }),
  ),
);

it.effect("keeps other frontmatter keys, refuses diverged copies, and trashes skills", () =>
  inProject((root) =>
    Effect.gen(function* () {
      const skills = yield* SkillWriter.SkillWriter;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = CommandCenterSkillName.make("triage");
      const agentsFile = path.join(root, ".agents", "skills", name, "SKILL.md");
      const claudeFile = path.join(root, ".claude", "skills", name, "SKILL.md");
      const input = { projectId, name, description: "Use when triaging.", content: "Body" };
      yield* skills.create(input);
      const withTools = "---\nname: triage\ndescription: Old.\nallowed-tools: Read\n---\n\nOld\n";
      yield* fs.writeFileString(agentsFile, withTools);
      yield* fs.writeFileString(claudeFile, withTools.replace(/\n/g, "\r\n"));

      yield* skills.update(input);
      const updated = yield* fs.readFileString(agentsFile);
      assert.match(
        updated,
        /description: Use when triaging\.\nallowed-tools: Read\n---\n\nBody\n$/,
      );

      yield* fs.writeFileString(claudeFile, "---\nname: triage\ndescription: Edited.\n---\n\nX\n");
      assert.include((yield* skills.update(input).pipe(Effect.flip)).message, "differ");
      assert.strictEqual(
        yield* fs.readFileString(claudeFile),
        "---\nname: triage\ndescription: Edited.\n---\n\nX\n",
      );

      yield* skills.remove({ projectId, name });
      expect((yield* skills.list({ projectId })).skills).toEqual([]);
      expect(yield* skills.restore({ projectId, name })).toEqual({
        skill: { name, description: "Use when triaging.", inAgents: true, inClaude: true },
      });
      assert.strictEqual(
        (yield* skills.restore({ projectId, name }).pipe(Effect.flip)).message,
        'A skill named "triage" already exists; delete it first.',
      );
    }),
  ),
);

it("ships valid built-in starters", () => {
  for (const file of WORKFLOW_STARTER_FILES) {
    expect(parseCommandCenterWorkflow(file).errors).toEqual([]);
  }
  expect(WORKFLOW_STARTERS.map((starter) => starter.slug)).toEqual([
    "onboarding",
    "feature",
    "bugfix",
    "release-notes",
    "weekly-digest",
  ]);
});

const run = (
  id: string,
  startedAt: string,
  finishedAt: string | null,
): CommandCenterWorkflowRun => ({
  id: CommandCenterWorkflowRunId.make(id),
  slug,
  title: "Feature",
  projectId,
  environmentId: EnvironmentId.make("environment:workflows"),
  status: finishedAt === null ? "running" : "succeeded",
  inputs: { feature: "Dark mode" },
  error: null,
  startedAt,
  finishedAt,
  updatedAt: finishedAt ?? startedAt,
});

it.effect("keeps runs for reading, refuses projects it does not have, and prunes old ones", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowRunner.makeWorkflowRunStore;
    const runner = yield* WorkflowRunner.WorkflowRunner;
    const now = "2026-10-13T00:00:00.000Z";
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(now)));
    yield* store.saveRun(
      run("old", "2020-01-01T00:00:00.000Z", "2020-01-01T01:00:00.000Z"),
      feature,
    );
    yield* store.saveRun(run("live", now, null), feature);
    yield* store.saveStep(projectId, {
      id: "live:plan:1",
      runId: CommandCenterWorkflowRunId.make("live"),
      nodeId: plan,
      item: null,
      attempt: 1,
      threadId: null,
      status: "running",
      output: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    });

    const page = yield* runner.list({ projectId, limit: 1 });
    assert.deepStrictEqual(
      page.runs.map((entry) => entry.id),
      ["live"],
    );
    assert.isTrue(page.hasMore);
    const older = yield* runner.list({ before: CommandCenterWorkflowRunId.make("live") });
    assert.deepStrictEqual(
      older.runs.map((entry) => entry.id),
      ["old"],
    );
    const detail = yield* runner.get({ runId: CommandCenterWorkflowRunId.make("live") });
    assert.strictEqual(detail.workflow.slug, "feature");
    assert.deepStrictEqual(
      detail.steps.map((step) => step.status),
      ["running"],
    );
    const [snapshot] = yield* runner
      .subscribe({ projectId })
      .pipe(Stream.take(1), Stream.runCollect);
    expect(snapshot).toMatchObject({ type: "snapshot", steps: [{ id: "live:plan:1" }] });

    const refused = yield* runner.start({ projectId, slug }).pipe(Effect.flip);
    assert.include(refused.message, "not on this machine");

    yield* (yield* CommandCenterService.CommandCenterService).runDailyMaintenance();
    assert.deepStrictEqual(
      (yield* runner.list({})).runs.map((entry) => entry.id),
      ["live"],
    );
  }).pipe(Effect.provide(layerTest())),
);
