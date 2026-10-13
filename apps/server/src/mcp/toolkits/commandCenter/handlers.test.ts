import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandCenterSectionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Artifacts from "../../../commandCenter/ArtifactsService.ts";
import * as CommandCenter from "../../../commandCenter/CommandCenterService.ts";
import { layerTest } from "../../../commandCenter/CommandCenterService.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as CommandCenterHandlers from "./handlers.ts";
import { ARTIFACT_GET_MAX_CHARS, CommandCenterToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:command-center");
// The project liveThreadShell gives every caller thread.
const callerProject = ProjectId.make("project:mcp-test");
const otherProject = ProjectId.make("project:other");

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:command-center"),
  requestNamespace: "provider:command-center",
  thread: {
    threadId,
    providerSessionId: "provider:command-center",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};
const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  ...threadCaller,
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Code", access: "read-only" },
};

const layerFor = (
  scope: McpInvocationContext.McpInvocationScope,
  home = true,
  projects?: Readonly<Record<string, string>>,
) =>
  McpToolAccess.HandlersLayer.layer(CommandCenterHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        liveThreadsLayer,
        layerTest({ home, ...(projects === undefined ? {} : { projects }) }),
      ),
    ),
  );

/** The final result of one tool call: its success value or its returned failure. */
const result = <A, E, R>(
  handled: Effect.Effect<Stream.Stream<{ readonly result: A }, E, R>, E, R>,
) =>
  handled.pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((results) => results.at(-1)?.result),
  );

it.effect("saves, recalls and completes memory for the calling thread's project", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const saved = yield* result(
      toolkit.handle("memory_save", { kind: "todo", text: "Add Stripe keys" }),
    );
    expect(saved).toMatchObject({ projectId: callerProject, threadId, source: "agent" });
    assert(saved !== undefined && "id" in saved && "kind" in saved);
    yield* result(
      toolkit.handle("memory_save", {
        kind: "progress",
        text: "Elsewhere",
        projectId: otherProject,
      }),
    );

    expect(yield* result(toolkit.handle("memory_recall", {}))).toMatchObject({
      openTodos: [{ id: saved.id }],
      progress: [],
    });
    expect(yield* result(toolkit.handle("memory_recall", { projectId: null }))).toMatchObject({
      progress: [{ text: "Elsewhere" }],
    });

    expect(yield* result(toolkit.handle("memory_complete", { id: saved.id }))).toMatchObject({
      done: true,
    });
    expect(yield* result(toolkit.handle("memory_recall", {}))).toMatchObject({ openTodos: [] });
  }).pipe(Effect.provide(layerFor(threadCaller))),
);

it.effect("updates only the section fields an agent passes", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const service = yield* CommandCenter.CommandCenterService;
    const record = yield* service.upsert({
      entity: "section",
      value: {
        projectId: callerProject,
        name: "Checkout",
        status: "in_progress",
        tasksDone: 1,
        tasksTotal: 4,
        dueDate: "2026-11-01",
        trying: "Wire the checkout",
        blocker: null,
        missing: ["Stripe keys"],
        sortKey: 0,
      },
    });
    assert(record.entity === "section");

    expect(
      yield* result(
        toolkit.handle("section_update", {
          id: record.value.id,
          status: "blocked",
          blocker: "No Stripe keys",
        }),
      ),
    ).toMatchObject({
      name: "Checkout",
      status: "blocked",
      tasksDone: 1,
      dueDate: "2026-11-01",
      trying: "Wire the checkout",
      blocker: "No Stripe keys",
      missing: ["Stripe keys"],
    });
    expect(yield* result(toolkit.handle("section_list", {}))).toMatchObject({
      sections: [{ status: "blocked" }],
    });
    expect(yield* result(toolkit.handle("section_list", { projectId: otherProject }))).toEqual({
      sections: [],
    });
    expect(
      yield* result(
        toolkit.handle("section_update", {
          id: CommandCenterSectionId.make("missing"),
          status: "done",
        }),
      ),
    ).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(layerFor(threadCaller))),
);

it.effect("refuses memory writes from a read-only client but lets it recall", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    expect(
      yield* result(toolkit.handle("memory_save", { kind: "note", text: "Nope" })),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* result(toolkit.handle("memory_recall", {}))).toMatchObject({ openTodos: [] });
  }).pipe(Effect.provide(layerFor(readOnlyClient))),
);

it.effect("refuses memory tools on a machine that is not the Command Center home", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const refused = yield* result(toolkit.handle("memory_save", { kind: "note", text: "Lost" }));
    expect(refused).toMatchObject({ message: expect.stringContaining("not set up") });
    expect(yield* result(toolkit.handle("memory_recall", {}))).toMatchObject({
      message: expect.stringContaining("not set up"),
    });
  }).pipe(Effect.provide(layerFor(threadCaller, false))),
);

it.effect("creates sections once per name and patches only the passed fields", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const created = yield* result(
      toolkit.handle("section_create", { name: "Auth", tasksTotal: 3, missing: ["OAuth app"] }),
    );
    expect(created).toMatchObject({
      projectId: callerProject,
      name: "Auth",
      status: "todo",
      tasksDone: 0,
      tasksTotal: 3,
      dependsOn: [],
    });
    assert(created !== undefined && "dependsOn" in created);
    const again = yield* result(toolkit.handle("section_create", { name: "auth", tasksTotal: 9 }));
    expect(again).toMatchObject({ id: created.id, tasksTotal: 3 });

    const other = yield* result(
      toolkit.handle("section_create", { name: "Billing", projectId: otherProject }),
    );
    assert(other !== undefined && "dependsOn" in other);
    expect(
      yield* result(
        toolkit.handle("section_update", {
          id: created.id,
          dueDate: "2026-12-01",
          dependsOn: [other.id],
        }),
      ),
    ).toMatchObject({
      name: "Auth",
      tasksTotal: 3,
      missing: ["OAuth app"],
      dueDate: "2026-12-01",
      dependsOn: [other.id],
    });

    const prUrl = "https://github.com/acme/shop/pull/42";
    expect(
      yield* result(toolkit.handle("section_update", { id: created.id, prUrl })),
    ).toMatchObject({ prUrl, prNumber: 42, dueDate: "2026-12-01" });
    expect(
      yield* result(toolkit.handle("section_update", { id: created.id, prUrl: null })),
    ).toMatchObject({ prUrl: null, prNumber: null });
  }).pipe(Effect.provide(layerFor(threadCaller))),
);

it.effect("returns the cached project digest for the calling thread's project", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const service = yield* CommandCenter.CommandCenterService;
    const saved = yield* service.upsert({
      entity: "memory",
      value: {
        projectId: callerProject,
        sectionId: null,
        threadId: null,
        kind: "note",
        text: "Repo digest for /repo\nfiles: 3",
        done: false,
        source: "system",
      },
    });
    expect(yield* result(toolkit.handle("project_digest", {}))).toMatchObject({
      id: saved.value.id,
      text: "Repo digest for /repo\nfiles: 3",
    });
    // No workspace is known for this project, so building one fails as a returned error.
    expect(
      yield* result(toolkit.handle("project_digest", { projectId: otherProject })),
    ).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(layerFor(threadCaller))),
);

it.effect("saves artifacts as the calling agent and reads them back without the theme", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const artifacts = yield* Artifacts.ArtifactsService;
    const created = yield* result(
      toolkit.handle("artifact_save", { title: "Plan", content: "<h1>Plan</h1>" }),
    );
    expect(created).toMatchObject({ version: 1, title: "Plan" });
    assert(created !== undefined && "version" in created && "id" in created);
    yield* result(toolkit.handle("artifact_save", { id: created.id, content: "<h1>Plan 2</h1>" }));
    yield* result(
      toolkit.handle("artifact_save", {
        title: "Elsewhere",
        kind: "markdown",
        content: "# Other",
        projectId: otherProject,
      }),
    );

    const { versions } = yield* artifacts.get({ id: created.id });
    expect(versions[0]).toMatchObject({ author: "agent", authorLabel: "codex", threadId });
    expect(yield* result(toolkit.handle("artifact_list", {}))).toMatchObject({
      artifacts: [{ id: created.id, projectId: callerProject, version: 2, kind: "html" }],
      hasMore: false,
    });
    const every = yield* result(toolkit.handle("artifact_list", { projectId: null }));
    assert(every !== undefined && "artifacts" in every);
    expect(every.artifacts.map((artifact) => artifact.title).toSorted()).toEqual([
      "Elsewhere",
      "Plan",
    ]);
    const read = yield* result(toolkit.handle("artifact_get", { id: created.id, version: 1 }));
    expect(read).toMatchObject({ version: 1, currentVersion: 2, title: "Plan" });
    assert(read !== undefined && "content" in read);
    expect(read.content).toContain("<h1>Plan</h1>");
    expect(read.content).not.toContain("t3-theme");
  }).pipe(Effect.provide(layerFor(threadCaller))),
);

it.effect("refuses artifact writes from a read-only client but lets it list", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    expect(
      yield* result(toolkit.handle("artifact_save", { title: "Nope", content: "x" })),
    ).toMatchObject({ code: "capability_denied" });
    expect(yield* result(toolkit.handle("artifact_list", {}))).toMatchObject({ artifacts: [] });
  }).pipe(Effect.provide(layerFor(readOnlyClient))),
);

it.effect("hands agents inlined images as placeholders, pages long content and restores them", () =>
  Effect.gen(function* () {
    const toolkit = yield* CommandCenterToolkit;
    const artifacts = yield* Artifacts.ArtifactsService;
    const image = `data:image/png;base64,${"A".repeat(500)}`;
    const body = "x".repeat(ARTIFACT_GET_MAX_CHARS);
    const created = yield* result(
      toolkit.handle("artifact_save", {
        title: "Shot",
        content: `<img src="${image}"><p>${body}</p>`,
      }),
    );
    assert(created !== undefined && "id" in created && "version" in created);

    const first = yield* result(toolkit.handle("artifact_get", { id: created.id }));
    assert(first !== undefined && "content" in first);
    expect(first.content).toContain('<img src="data:t3-inline/0">');
    expect(first.content).not.toContain("base64");
    expect(first).toMatchObject({ truncated: true, nextOffset: ARTIFACT_GET_MAX_CHARS });
    const rest = yield* result(
      toolkit.handle("artifact_get", { id: created.id, offset: ARTIFACT_GET_MAX_CHARS }),
    );
    assert(rest !== undefined && "content" in rest);
    expect(rest).toMatchObject({ truncated: false, nextOffset: null });
    expect(first.content + rest.content).toHaveLength(first.totalChars);

    yield* result(
      toolkit.handle("artifact_save", {
        id: created.id,
        content: '<h1>Shot</h1><img src="data:t3-inline/0">',
      }),
    );
    const saved = yield* artifacts.get({ id: created.id, includeContent: true });
    expect(saved.content).toContain(`<h1>Shot</h1><img src="${image}">`);
    expect(
      yield* result(
        toolkit.handle("artifact_save", {
          id: created.id,
          content: '<img src="data:t3-inline/3">',
        }),
      ),
    ).toMatchObject({ code: "invalid_request" });
  }).pipe(Effect.provide(layerFor(threadCaller))),
);

/** Runs `test` with the caller's project rooted in a temporary folder. */
const inCallerProject = <A, E>(
  home: boolean,
  test: Effect.Effect<A, E, Layer.Success<ReturnType<typeof layerFor>>>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-workflows-" });
    return yield* test.pipe(
      Effect.provide(layerFor(threadCaller, home, { [callerProject]: root })),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("saves workflows and skills in the caller's project and keeps runs on the home", () =>
  inCallerProject(
    true,
    Effect.gen(function* () {
      const toolkit = yield* CommandCenterToolkit;
      const invalid = yield* result(
        toolkit.handle("workflow_save", {
          workflow: { slug: "loop", title: "Loop", nodes: [{ id: "a", kind: "loop" }] },
        }),
      );
      expect(invalid).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining('unknown kind "loop"'),
      });

      const starter = yield* result(
        toolkit.handle("workflow_get", { slug: "bugfix", starter: true }),
      );
      assert(starter !== undefined && "workflow" in starter && starter.workflow !== null);
      expect(
        yield* result(toolkit.handle("workflow_save", { workflow: starter.workflow })),
      ).toMatchObject({ slug: "bugfix" });
      expect(yield* result(toolkit.handle("workflow_list", {}))).toMatchObject({
        workflows: [{ slug: "bugfix", inputs: ["bug"], nodeCount: 3, error: null }],
        starters: expect.arrayContaining([{ slug: "feature", title: "Feature" }]),
      });

      expect(
        yield* result(
          toolkit.handle("skill_create", {
            name: "triage",
            description: "Use when triaging a bug report.",
            content: "Reproduce first.",
          }),
        ),
      ).toEqual({ name: "triage", inAgents: true, inClaude: true });

      // An unsaved starter still runs, so its required input is asked for.
      expect(yield* result(toolkit.handle("workflow_run", { slug: "bugfix" }))).toMatchObject({
        code: "invalid_request",
        message: 'Give a value for "bug".',
      });
      expect(yield* result(toolkit.handle("workflow_status", {}))).toEqual({ runs: [], steps: [] });
      expect(
        yield* result(
          toolkit.handle("agent_profile_save", { name: "Reviewer", role: "Reviews diffs" }),
        ),
      ).toMatchObject({ name: "Reviewer" });
    }),
  ),
);

it.effect("writes project files away from the Command Center home, but not profiles", () =>
  inCallerProject(
    false,
    Effect.gen(function* () {
      const toolkit = yield* CommandCenterToolkit;
      const starter = yield* result(
        toolkit.handle("workflow_get", { slug: "feature", starter: true }),
      );
      assert(starter !== undefined && "workflow" in starter && starter.workflow !== null);
      expect(
        yield* result(toolkit.handle("workflow_save", { workflow: starter.workflow })),
      ).toMatchObject({ slug: "feature" });
      expect(
        yield* result(toolkit.handle("agent_profile_save", { name: "Reviewer" })),
      ).toMatchObject({ code: "invalid_request" });
    }),
  ),
);
