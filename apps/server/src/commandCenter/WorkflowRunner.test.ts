import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandCenterSkillName,
  CommandCenterSnippetName,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowSlug,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CommandCenterWorkflow,
  type CommandCenterWorkflowAgentNode,
  type CommandCenterWorkflowNode,
  type CommandCenterWorkflowRunStatus,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ScheduledTaskPromptRoutes } from "../scheduledTasks/ScheduledTaskPromptRoutes.ts";
import * as CommandCenterService from "./CommandCenterService.ts";
import { layerTest, TEST_ENVIRONMENT_ID } from "./CommandCenterService.testkit.ts";
import * as WorkflowRunner from "./WorkflowRunner.ts";
import type {
  WorkflowThreadLaunch,
  WorkflowThreadResult,
  WorkflowThreads,
} from "./workflowThreads.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const projectId = ProjectId.make("project:runner");
const slug = CommandCenterWorkflowSlug.make("ship");
const node = (id: string) => CommandCenterWorkflowNodeId.make(id);

const agent = (
  id: string,
  prompt: string,
  extra: Partial<CommandCenterWorkflowAgentNode> = {},
): CommandCenterWorkflowAgentNode => ({
  id: node(id),
  kind: "agent",
  prompt,
  skills: [],
  worktree: false,
  outputs: "text",
  ...extra,
});

const workflow = (
  nodes: ReadonlyArray<CommandCenterWorkflowNode>,
  edges: ReadonlyArray<readonly [string, string]> = [],
  inputs: CommandCenterWorkflow["inputs"] = [],
): CommandCenterWorkflow => ({
  slug,
  title: "Ship",
  description: "",
  inputs,
  nodes,
  edges: edges.map(([from, to]) => ({ from: node(from), to: node(to) })),
  layout: {},
});

/**
 * Step threads the test settles by hand: every launch lands in a queue, and a thread's
 * `awaitSettled` waits on a Deferred the test completes.
 */
const makeThreads = Effect.gen(function* () {
  const launches = yield* Queue.unbounded<WorkflowThreadLaunch>();
  const results = new Map<string, Deferred.Deferred<WorkflowThreadResult>>();
  const stopped: string[] = [];
  const resultFor = (threadId: string) => {
    const existing = results.get(threadId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<WorkflowThreadResult>();
    results.set(threadId, created);
    return created;
  };
  const service: WorkflowThreads["Service"] = {
    readDigests: () => Effect.succeed({ digests: [] }),
    launch: (input) =>
      Queue.offer(launches, input).pipe(Effect.as(ThreadId.make(`thread:${input.key}`))),
    awaitSettled: (threadId) => Deferred.await(resultFor(threadId)),
    stop: (threadId) =>
      Effect.sync(() => {
        stopped.push(threadId);
      }),
    // Build steps work in a worktree; checks after them should run there.
    worktree: (threadId) =>
      Effect.succeed(
        threadId.includes(":build:") ? { path: "/worktrees/ship", branch: "wf/ship" } : null,
      ),
  };
  return {
    service,
    stopped,
    next: Queue.take(launches),
    pending: Queue.size(launches),
    settle: (key: string, ok: boolean, text: string) =>
      Deferred.succeed(resultFor(`thread:${key}`), { ok, text }),
  };
});
type Threads = Effect.Success<typeof makeThreads>;

type Services =
  | WorkflowRunner.WorkflowRunner
  | WorkflowStore.WorkflowStore
  | CommandCenterService.CommandCenterService
  | ScheduledTaskPromptRoutes
  | FileSystem.FileSystem
  | Path.Path;

/** Runs `test` on a temporary project folder with hand-settled step threads. */
const withRunner = <A, E>(test: (threads: Threads) => Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cc-runner-" });
    const threads = yield* makeThreads;
    return yield* test(threads).pipe(
      Effect.provide(layerTest({ projects: { [projectId]: root }, threads: threads.service })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** The run once it reaches `status`, from the change feed (its snapshot covers a past change). */
const awaitRun = (runId: CommandCenterWorkflowRunId, status: CommandCenterWorkflowRunStatus) =>
  Effect.gen(function* () {
    const runner = yield* WorkflowRunner.WorkflowRunner;
    const run = yield* runner.subscribe({ projectId }).pipe(
      Stream.flatMap((event) =>
        Stream.fromIterable(
          event.type === "snapshot" ? event.runs : event.type === "run" ? [event.run] : [],
        ),
      ),
      Stream.filter((entry) => entry.id === runId && entry.status === status),
      Stream.runHead,
    );
    return Option.getOrThrow(run);
  });

const stepsOf = (runId: CommandCenterWorkflowRunId) =>
  Effect.gen(function* () {
    const runner = yield* WorkflowRunner.WorkflowRunner;
    return (yield* runner.get({ runId })).steps.map((step) => ({
      node: step.nodeId,
      item: step.item,
      attempt: step.attempt,
      status: step.status,
      output: step.output,
      error: step.error,
    }));
  });

it.effect("runs steps in order, hands short results on and expands snippets", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const runner = yield* WorkflowRunner.WorkflowRunner;
      const store = yield* WorkflowStore.WorkflowStore;
      yield* store.saveSnippet({
        projectId,
        name: CommandCenterSnippetName.make("house-style"),
        content: "Keep diffs small.",
      });
      const run = yield* runner.start({
        projectId,
        slug,
        inputs: { feature: "Dark mode" },
        workflow: workflow(
          [
            agent("plan", "Plan {{input:feature}}. {{snippet:house-style}}", {
              outputs: "memory",
            }),
            agent("build", "Build the plan.", {
              worktree: true,
              skills: [CommandCenterSkillName.make("tdd")],
            }),
            { id: node("check"), kind: "gate", check: "tests" },
          ],
          [
            ["plan", "build"],
            ["build", "check"],
          ],
          [{ name: "feature", label: "Feature" }],
        ),
      });
      assert.strictEqual(run.status, "running");
      assert.strictEqual(run.environmentId, TEST_ENVIRONMENT_ID);

      const plan = yield* threads.next;
      assert.strictEqual(plan.key, `${run.id}:plan:-:1`);
      assert.include(plan.prompt, "Plan Dark mode. Keep diffs small.");
      assert.deepStrictEqual(plan.workspace, { type: "root" });
      assert.strictEqual(yield* threads.pending, 0);
      yield* threads.settle(plan.key, true, "Split the theme tokens first.");

      const build = yield* threads.next;
      assert.include(build.prompt, "## plan\nSplit the theme tokens first.");
      assert.include(build.prompt, "Use these skills: tdd.");
      expect(build.workspace).toMatchObject({ type: "worktree", baseRef: "HEAD" });
      assert.match(
        build.workspace.type === "worktree" ? (build.workspace.branch ?? "") : "",
        /^wf\/ship-build-[0-9a-f]{8}$/,
      );
      const commandCenter = yield* CommandCenterService.CommandCenterService;
      expect((yield* commandCenter.getSnapshot()).memory).toMatchObject([
        { kind: "handoff", text: "Split the theme tokens first.", threadId: `thread:${plan.key}` },
      ]);
      yield* threads.settle(build.key, true, "Done.");

      const check = yield* threads.next;
      assert.include(check.prompt, "End your reply with one line: PASS");
      assert.deepStrictEqual(check.workspace, {
        type: "existing_worktree",
        worktreePath: "/worktrees/ship",
        branch: "wf/ship",
      });
      yield* threads.settle(check.key, true, "All 12 tests pass.\nPASS");

      const finished = yield* awaitRun(run.id, "succeeded");
      assert.isNotNull(finished.finishedAt);
      expect(yield* stepsOf(run.id)).toMatchObject([
        { node: "build", status: "succeeded", output: "Done." },
        { node: "check", status: "succeeded", output: "Passed." },
        { node: "plan", status: "succeeded", output: "Split the theme tokens first." },
      ]);
    }),
  ),
);

it.effect("fans a parallel step out three at a time and joins the results", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const runner = yield* WorkflowRunner.WorkflowRunner;
      const run = yield* runner.start({
        projectId,
        slug,
        inputs: { files: "- a.ts\n- b.ts\n- c.ts\n- d.ts" },
        workflow: workflow(
          [
            { id: node("each"), kind: "parallel", over: "files", node: node("review") },
            agent("review", "Review {{item}}."),
            agent("sum", "Summarize the reviews."),
          ],
          [["each", "sum"]],
          [{ name: "files", label: "Files" }],
        ),
      });
      const a = yield* threads.next;
      const b = yield* threads.next;
      const c = yield* threads.next;
      assert.deepStrictEqual(
        [a, b, c].map((launch) => launch.key),
        [0, 1, 2].map((item) => `${run.id}:review:${item}:1`),
      );
      assert.include(a.prompt, "Review a.ts.");
      assert.strictEqual(yield* threads.pending, 0);

      yield* threads.settle(b.key, true, "b is fine");
      const fourth = yield* threads.next;
      assert.strictEqual(fourth.key, `${run.id}:review:3:1`);
      assert.include(fourth.prompt, "Review d.ts.");
      yield* threads.settle(a.key, true, "a is fine");
      yield* threads.settle(c.key, true, "c is fine");
      yield* threads.settle(fourth.key, true, "d is fine");

      const sum = yield* threads.next;
      assert.include(sum.prompt, "1. a is fine\n2. b is fine\n3. c is fine\n4. d is fine");
      yield* threads.settle(sum.key, true, "All good.");
      yield* awaitRun(run.id, "succeeded");
    }),
  ),
);

it.effect("waits on asks and manual gates, stops on a non-default choice and resumes", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const runner = yield* WorkflowRunner.WorkflowRunner;
      const run = yield* runner.start({
        projectId,
        slug,
        workflow: workflow(
          [
            { id: node("confirm"), kind: "ask", question: "Ship it?", choices: ["Ship", "Hold"] },
            { id: node("approve"), kind: "gate", check: "manual" },
            agent("release", "Release."),
          ],
          [
            ["confirm", "approve"],
            ["approve", "release"],
          ],
        ),
      });
      assert.strictEqual(run.status, "waiting");
      const confirm = node("confirm");

      const held = yield* runner.answer({ runId: run.id, nodeId: confirm, answer: "Hold" });
      assert.strictEqual(held.status, "stopped");
      assert.strictEqual(held.error, "Stopped at confirm: Hold");

      assert.strictEqual((yield* runner.resume({ runId: run.id })).status, "waiting");
      yield* runner.answer({ runId: run.id, nodeId: confirm, answer: "Ship" });
      const rejected = yield* runner.answer({
        runId: run.id,
        nodeId: node("approve"),
        approved: false,
        answer: "Not on a Friday",
      });
      assert.strictEqual(rejected.status, "failed");
      assert.strictEqual(rejected.error, "approve failed: Rejected: Not on a Friday");

      yield* runner.retryStep({ runId: run.id, nodeId: node("approve") });
      const notWaiting = yield* runner
        .answer({ runId: run.id, nodeId: confirm, answer: "Ship" })
        .pipe(Effect.flip);
      assert.strictEqual(notWaiting.message, "That step is not waiting for an answer.");
      yield* runner.answer({ runId: run.id, nodeId: node("approve"), approved: true });

      const release = yield* threads.next;
      // The ask's answer comes along with the gate's result, oldest first.
      assert.include(release.prompt, "## confirm\nShip\n\n## approve\nApproved.");
      expect(yield* stepsOf(run.id)).toMatchObject([
        { node: "approve", attempt: 1, status: "failed" },
        { node: "approve", attempt: 2, status: "succeeded" },
        { node: "confirm", attempt: 1, status: "stopped", output: "Hold" },
        { node: "confirm", attempt: 2, status: "succeeded", output: "Ship" },
        { node: "release", attempt: 1, status: "running" },
      ]);
    }),
  ),
);

it.effect("fans out over a step's full item list, each item on its own branch", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const runner = yield* WorkflowRunner.WorkflowRunner;
      yield* runner.start({
        projectId,
        slug,
        workflow: workflow(
          [
            agent("list", "List the files."),
            { id: node("each"), kind: "parallel", over: "list", node: node("fix") },
            agent("fix", "Fix {{item}} ($& stays).", { worktree: true }),
          ],
          [["list", "each"]],
        ),
      });
      // Longer than a step's stored output, so the last item is past the clip.
      const items = ["a", "b", "c"].map((name) => `${name}.ts ${"x".repeat(900)} end-${name}`);
      yield* threads.settle((yield* threads.next).key, true, items.map((i) => `- ${i}`).join("\n"));

      const launches = [yield* threads.next, yield* threads.next, yield* threads.next];
      assert.include(launches[2]?.prompt, `Fix ${items[2]} ($& stays).`);
      const branches = launches.map((launch) =>
        launch.workspace.type === "worktree" ? launch.workspace.branch : null,
      );
      branches.forEach((branch, index) =>
        assert.match(branch ?? "", new RegExp(`^wf/ship-fix-${index + 1}-[0-9a-f]{8}$`)),
      );
    }),
  ),
);

it.effect("runs a scheduled `/wf` prompt within the task's modes and leaves other prompts", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const store = yield* WorkflowStore.WorkflowStore;
      const routes = yield* ScheduledTaskPromptRoutes;
      yield* store.save({
        projectId,
        workflow: workflow(
          [agent("plan", "Plan {{input:feature}}")],
          [],
          [{ name: "feature", label: "Feature" }],
        ),
      });
      const task = {
        projectId,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      } as const;
      assert.isFalse(yield* routes.route({ ...task, prompt: "Summarize the week." }));
      assert.isTrue(yield* routes.route({ ...task, prompt: "/wf ship Dark mode" }));
      const plan = yield* threads.next;
      assert.include(plan.prompt, "Plan Dark mode");
      assert.strictEqual(plan.runtimeMode, "approval-required");
      assert.strictEqual(plan.interactionMode, "plan");
      const unknown = yield* routes
        .route({ ...task, prompt: "/wf ship colour=red" })
        .pipe(Effect.flip);
      assert.strictEqual(unknown.message, 'The workflow "ship" has no input "colour".');
    }),
  ),
);

it.effect("retries a failed step and stops a running one with its thread", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const runner = yield* WorkflowRunner.WorkflowRunner;
      const run = yield* runner.start({
        projectId,
        slug,
        workflow: workflow([agent("fix", "Fix it."), agent("test", "Test it.")], [["fix", "test"]]),
      });
      const fix = yield* threads.next;
      yield* threads.settle(fix.key, false, "The provider crashed.");
      const failed = yield* awaitRun(run.id, "failed");
      assert.strictEqual(failed.error, "fix failed: The provider crashed.");

      const refused = yield* runner
        .retryStep({ runId: run.id, nodeId: node("test") })
        .pipe(Effect.flip);
      assert.strictEqual(refused.message, "Only a failed or stopped step can be retried.");
      assert.strictEqual(
        (yield* runner.retryStep({ runId: run.id, nodeId: node("fix") })).status,
        "running",
      );
      const again = yield* threads.next;
      assert.strictEqual(again.key, `${run.id}:fix:-:2`);
      yield* threads.settle(again.key, true, "Fixed.");

      const test = yield* threads.next;
      const stopped = yield* runner.stop({ runId: run.id });
      assert.strictEqual(stopped.status, "stopped");
      assert.deepStrictEqual(threads.stopped, [`thread:${test.key}`]);
      // Stopping twice is a no-op.
      assert.strictEqual((yield* runner.stop({ runId: run.id })).status, "stopped");

      assert.strictEqual((yield* runner.resume({ runId: run.id })).status, "running");
      assert.strictEqual((yield* threads.next).key, `${run.id}:test:-:2`);
    }),
  ),
);

it.effect("refuses unknown inputs and other environments, and fails on a missing snippet", () =>
  withRunner((threads) =>
    Effect.gen(function* () {
      const runner = yield* WorkflowRunner.WorkflowRunner;
      const steps = workflow([agent("a", "Use {{snippet:missing}}")]);
      const unknown = yield* runner
        .start({ projectId, slug, workflow: steps, inputs: { nope: "x" } })
        .pipe(Effect.flip);
      assert.include(unknown.message, 'Unknown input "nope"');
      const elsewhere = yield* runner
        .start({
          projectId,
          slug,
          workflow: steps,
          environmentId: EnvironmentId.make("environment-other"),
        })
        .pipe(Effect.flip);
      assert.include(elsewhere.message, "start the run on the environment that has the project");
      // Snippets are read at launch, so the step fails and says why.
      const run = yield* runner.start({ projectId, slug, workflow: steps });
      assert.strictEqual(run.status, "failed");
      assert.strictEqual(run.error, 'a failed: No snippet named "missing".');
      assert.strictEqual(yield* threads.pending, 0);
    }),
  ),
);

it.effect("follows running steps again after a restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cc-runner-" });
    const database = path.join(root, "state.sqlite");
    const runId = CommandCenterWorkflowRunId.make("run-before-restart");
    const now = "2026-10-13T00:00:00.000Z";
    const step = (nodeId: string, threadId: string | null) => ({
      id: `${runId}:${nodeId}:-:1`,
      runId,
      nodeId: node(nodeId),
      item: null,
      attempt: 1,
      threadId: threadId === null ? null : ThreadId.make(threadId),
      status: "running" as const,
      output: null,
      error: null,
      startedAt: now,
      finishedAt: null,
      updatedAt: now,
    });

    // Before: a run with one step following its thread, and one whose launch never returned.
    // Command Center off, so this server's runner leaves the rows alone.
    yield* Effect.gen(function* () {
      const store = yield* WorkflowRunner.makeWorkflowRunStore;
      yield* store.saveRun(
        {
          id: runId,
          slug,
          title: "Ship",
          projectId,
          environmentId: TEST_ENVIRONMENT_ID,
          status: "running",
          inputs: {},
          error: null,
          startedAt: now,
          finishedAt: null,
          updatedAt: now,
        },
        workflow(
          [agent("a", "A."), agent("b", "B."), agent("c", "C.")],
          [
            ["a", "c"],
            ["b", "c"],
          ],
        ),
      );
      yield* store.saveStep(projectId, step("a", `thread:${runId}:a:-:1`));
      yield* store.saveStep(projectId, step("b", null));
    }).pipe(
      Effect.provide(layerTest({ enabled: false, database, projects: { [projectId]: root } })),
    );

    // After: the runner relaunches b under the same key and waits on a's thread again.
    const threads = yield* makeThreads;
    yield* Effect.gen(function* () {
      const relaunched = yield* threads.next;
      assert.strictEqual(relaunched.key, `${runId}:b:-:1`);
      yield* threads.settle(`${runId}:a:-:1`, true, "A done.");
      yield* threads.settle(relaunched.key, true, "B done.");
      const c = yield* threads.next;
      assert.strictEqual(c.key, `${runId}:c:-:1`);
      assert.include(c.prompt, "## a\nA done.\n\n## b\nB done.");
    }).pipe(
      Effect.provide(
        layerTest({ database, projects: { [projectId]: root }, threads: threads.service }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("reads fan-out items and check verdicts", () => {
  assert.deepStrictEqual(WorkflowRunner.parseItems('["a", "b", ""]'), ["a", "b"]);
  assert.deepStrictEqual(WorkflowRunner.parseItems("Files:\n- a.ts\n* b.ts\n1. c.ts"), [
    "a.ts",
    "b.ts",
    "c.ts",
  ]);
  assert.deepStrictEqual(WorkflowRunner.parseItems("one\ntwo\n\n"), ["one", "two"]);
  assert.strictEqual(WorkflowRunner.parseItems(Array(80).fill("- x").join("\n")).length, 50);
  assert.isTrue(WorkflowRunner.checkPassed("Ran 3 suites.\n**PASS**"));
  assert.isFalse(WorkflowRunner.checkPassed("PASS so far\nFAIL two tests broke"));
  assert.isFalse(WorkflowRunner.checkPassed("Everything passes"));
});
