import { assert, expect, it } from "@effect/vitest";
import {
  CommandCenterSectionId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CommandCenter from "../../../commandCenter/CommandCenterService.ts";
import { layerTest } from "../../../commandCenter/CommandCenterService.testkit.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import * as CommandCenterHandlers from "./handlers.ts";
import { CommandCenterToolkit } from "./tools.ts";

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

const layerFor = (scope: McpInvocationContext.McpInvocationScope, home = true) =>
  McpToolAccess.HandlersLayer.layer(CommandCenterHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        liveThreadsLayer,
        layerTest({ home }),
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
