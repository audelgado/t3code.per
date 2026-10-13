import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskPromptRoutes from "../scheduledTasks/ScheduledTaskPromptRoutes.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ArtifactsService from "./ArtifactsService.ts";
import * as CommandCenterService from "./CommandCenterService.ts";
import * as SkillWriter from "./SkillWriter.ts";
import * as WorkflowRunner from "./WorkflowRunner.ts";
import { WorkflowThreads } from "./workflowThreads.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

interface TestOptions {
  readonly enabled?: boolean;
  readonly home?: boolean;
  readonly projects?: Readonly<Record<string, string>>;
  /** Thumbnail capture; defaults to a server without a preview browser. */
  readonly thumbnail?: HtmlRender.HtmlRender["Service"]["thumbnail"];
  /** A database file, to build the services twice over one store; in memory by default. */
  readonly database?: string;
  /** Workflow step threads; by default launches succeed and threads never settle. */
  readonly threads?: Partial<WorkflowThreads["Service"]>;
}

export const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-test");

/**
 * The Command Center, artifacts and workflow services on an in-memory database, with artifact files in a
 * temporary attachments directory (`ServerConfig`). Tests drive `runDailyMaintenance` themselves,
 * so the scheduler never runs it; `projects` maps project ids to workspace roots for the repo
 * digest. The machine is the Command Center home (a client opened it) unless `home` is false.
 */
export const layerTest = (options: TestOptions = {}) => {
  const service = layerService(options);
  if (options.home === false || options.enabled === false) return service;
  const markHome = Effect.gen(function* () {
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    yield* commandCenter.subscribe().pipe(Stream.take(1), Stream.runDrain);
  });
  return Layer.effectDiscard(markHome).pipe(Layer.provideMerge(service));
};

const layerService = (options: TestOptions) =>
  Layer.mergeAll(
    SkillWriter.layer,
    WorkflowRunner.layer.pipe(
      Layer.provide(
        Layer.mock(WorkflowThreads)({
          launch: (input) => Effect.succeed(ThreadId.make(`thread:${input.key}`)),
          awaitSettled: () => Effect.never,
          stop: () => Effect.void,
          worktree: () => Effect.succeed(null),
          ...options.threads,
        }),
      ),
      Layer.provideMerge(ScheduledTaskPromptRoutes.layer),
    ),
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(ArtifactsService.layer, WorkflowStore.layer)),
    Layer.provideMerge(
      CommandCenterService.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            options.database === undefined
              ? SqlitePersistence.layerMemory
              : SqlitePersistence.layerFromPath(options.database).pipe(
                  Layer.provide(NodeServices.layer),
                ),
            NodeCrypto.layer,
            NodeServices.layer,
            ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
            ServerSettings.layerTest({ commandCenter: { enabled: options.enabled ?? true } }),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(TEST_ENVIRONMENT_ID),
            }),
            Layer.succeed(
              Scheduler.Scheduler,
              Scheduler.Scheduler.of({ register: () => Effect.void }),
            ),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) => {
                const workspaceRoot = options.projects?.[id];
                return Effect.succeed(
                  workspaceRoot === undefined
                    ? Option.none()
                    : Option.some({
                        id: ProjectId.make(id),
                        title: "Test project",
                        workspaceRoot,
                        defaultModelSelection: null,
                        scripts: [],
                        createdAt: "2026-10-01T00:00:00.000Z",
                        updatedAt: "2026-10-01T00:00:00.000Z",
                        deletedAt: null,
                      }),
                );
              },
            }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-command-center-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(
      Layer.mock(HtmlRender.HtmlRender)({
        thumbnail: options.thumbnail ?? (() => Effect.succeedNone),
        // No local images to inline in tests: the page comes back as given.
        prepare: (html) => Effect.succeed(html),
      }),
    ),
  );
