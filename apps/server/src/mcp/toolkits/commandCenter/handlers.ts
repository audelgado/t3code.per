import {
  OrchestratorMcpFailure,
  type CommandCenterError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CommandCenter from "../../../commandCenter/CommandCenterService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { CommandCenterToolkit } from "./tools.ts";

// Service messages are written for people and carry no storage detail.
const failure = (error: CommandCenterError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * The caller's thread and the service, once the service agrees this machine is where the user
 * keeps Command Center (on, and opened here). Every tool goes through it.
 */
const access = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  const service = yield* CommandCenter.CommandCenterService;
  yield* service.checkAgentAccess().pipe(Effect.mapError(failure));
  return { caller, service };
});

const missingProject = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "Pass projectId; there is no calling thread to take the project from.",
});

/** Omitted means the calling thread's project (every project without one); null means every project. */
const projectFilter = (
  caller: { readonly projectId: ProjectId } | undefined,
  projectId: ProjectId | null | undefined,
) => (projectId === undefined ? (caller?.projectId ?? null) : projectId);

export const layer = McpToolAccess.toLayer(CommandCenterToolkit, {
  memory_save: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller, service } = yield* access;
      const record = yield* service
        .upsert({
          entity: "memory",
          value: {
            projectId: input.projectId ?? caller?.projectId ?? null,
            sectionId: input.sectionId ?? null,
            threadId: caller?.id ?? null,
            kind: input.kind,
            text: input.text,
            done: false,
            source: "agent",
          },
        })
        .pipe(Effect.mapError(failure));
      if (record.entity !== "memory") return yield* unavailable();
      return record.value;
    }),
  ),
  memory_recall: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, service } = yield* access;
      return yield* service
        .recallMemory({ projectId: projectFilter(caller, input.projectId) })
        .pipe(Effect.mapError(failure));
    }),
  ),
  memory_complete: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { service } = yield* access;
      return yield* service
        .setMemoryDone({ id: input.id, done: input.done ?? true })
        .pipe(Effect.mapError(failure));
    }),
  ),
  section_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, service } = yield* access;
      return yield* service
        .listSections(projectFilter(caller, input.projectId))
        .pipe(Effect.mapError(failure));
    }),
  ),
  section_update: McpToolAccess.writes(({ id, ...patch }) =>
    Effect.gen(function* () {
      const { service } = yield* access;
      return yield* service.patchSection(id, patch).pipe(Effect.mapError(failure));
    }),
  ),
  section_create: McpToolAccess.writes(({ projectId, ...input }) =>
    Effect.gen(function* () {
      const { caller, service } = yield* access;
      const project = projectId ?? caller?.projectId;
      if (project === undefined) return yield* missingProject;
      return yield* service
        .createSection({
          projectId: project,
          name: input.name,
          status: input.status ?? "todo",
          tasksDone: input.tasksDone ?? 0,
          tasksTotal: input.tasksTotal ?? 0,
          dueDate: input.dueDate ?? null,
          trying: input.trying ?? null,
          blocker: input.blocker ?? null,
          missing: input.missing ?? [],
          sortKey: 0,
          ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
        })
        .pipe(Effect.mapError(failure));
    }),
  ),
  project_digest: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { caller, service } = yield* access;
      const project = input.projectId ?? caller?.projectId;
      if (project === undefined) return yield* missingProject;
      return yield* service.getRepoDigest(project).pipe(Effect.mapError(failure));
    }),
  ),
});
