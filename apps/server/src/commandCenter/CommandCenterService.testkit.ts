import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandCenterService from "./CommandCenterService.ts";

/**
 * The service on an in-memory database. Tests drive `runDailyMaintenance` themselves, so the
 * scheduler never runs it; `projects` maps project ids to workspace roots for the repo digest.
 * The machine is the Command Center home (a client opened it) unless `home` is false.
 */
export const layerTest = (
  options: {
    readonly enabled?: boolean;
    readonly home?: boolean;
    readonly projects?: Readonly<Record<string, string>>;
  } = {},
) => {
  const service = layerService(options);
  if (options.home === false || options.enabled === false) return service;
  const markHome = Effect.gen(function* () {
    const commandCenter = yield* CommandCenterService.CommandCenterService;
    yield* commandCenter.subscribe().pipe(Stream.take(1), Stream.runDrain);
  });
  return Layer.effectDiscard(markHome).pipe(Layer.provideMerge(service));
};

const layerService = (options: {
  readonly enabled?: boolean;
  readonly projects?: Readonly<Record<string, string>>;
}) =>
  CommandCenterService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        NodeServices.layer,
        ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        ServerSettings.layerTest({ commandCenter: { enabled: options.enabled ?? true } }),
        Layer.succeed(Scheduler.Scheduler, Scheduler.Scheduler.of({ register: () => Effect.void })),
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
  );
