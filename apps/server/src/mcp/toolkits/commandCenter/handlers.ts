import {
  CommandCenterWorkflow,
  OrchestratorMcpFailure,
  parseCommandCenterWorkflow,
  pullRequestNumberFromUrl,
  type CommandCenterArtifactId,
  type CommandCenterArtifactKind,
  type CommandCenterError,
  type CommandCenterWorkflowRun,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Artifacts from "../../../commandCenter/ArtifactsService.ts";
import * as CommandCenter from "../../../commandCenter/CommandCenterService.ts";
import * as SkillWriter from "../../../commandCenter/SkillWriter.ts";
import * as WorkflowRunner from "../../../commandCenter/WorkflowRunner.ts";
import { WORKFLOW_STARTERS } from "../../../commandCenter/workflowStarters.ts";
import * as WorkflowStore from "../../../commandCenter/WorkflowStore.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { ARTIFACT_GET_MAX_CHARS, CommandCenterToolkit } from "./tools.ts";

// Service messages are written for people and carry no storage detail.
const failure = (error: CommandCenterError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/**
 * The caller's thread and the service, once the service agrees this machine is where the user
 * keeps Command Center (on, and opened here). Every tool goes through it.
 */
const access = Effect.gen(function* () {
  const { caller, scope } = yield* readCaller();
  const service = yield* CommandCenter.CommandCenterService;
  yield* service.checkAgentAccess().pipe(Effect.mapError(failure));
  return { caller, scope, service };
});

/** `access`, plus the artifacts library. */
const artifactAccess = Effect.gen(function* () {
  const { caller, scope } = yield* access;
  const artifacts = yield* Artifacts.ArtifactsService;
  return { caller, scope, artifacts };
});

const missingProject = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "Pass projectId; there is no calling thread to take the project from.",
});

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/**
 * An agent's page as it gets stored: the `data:t3-inline/<n>` images artifact_get elided put back
 * from the current version, and, for HTML from a T3 thread, local images inlined as html_render
 * does. Only agents T3 launched (already working on this machine) get files read for them; the
 * client RPC never inlines.
 */
const agentPage = Effect.fn("commandCenter.agentPage")(function* (
  artifacts: Artifacts.ArtifactsService["Service"],
  input: {
    readonly id?: CommandCenterArtifactId | undefined;
    readonly kind?: CommandCenterArtifactKind | undefined;
  },
  content: string,
  inlineLocalImages: boolean,
) {
  const current =
    input.id === undefined
      ? null
      : yield* artifacts
          .get({ id: input.id, includeContent: content.includes("data:t3-inline/") })
          .pipe(Effect.mapError(failure));
  let page = content;
  if (current?.content != null) {
    const restored = Artifacts.restoreInlineData(content, current.content);
    if (restored === null) {
      return yield* invalid(
        "A data:t3-inline placeholder is not in the current version; read it again with artifact_get.",
      );
    }
    page = restored;
  }
  if ((current?.artifact.kind ?? input.kind ?? "html") !== "html" || !inlineLocalImages) {
    return page;
  }
  const htmlRender = yield* HtmlRender.HtmlRender;
  return yield* htmlRender.prepare(page).pipe(Effect.mapError((error) => invalid(error.message)));
});

/**
 * The project a workflow or skill tool works on, without the Command Center home check: these
 * are files in the project, so they are written wherever the project lives (Command Center on).
 */
const projectAccess = Effect.fn("commandCenter.projectAccess")(function* (
  projectId: ProjectId | undefined,
) {
  const { caller } = yield* readCaller();
  const service = yield* CommandCenter.CommandCenterService;
  yield* service.requireEnabled().pipe(Effect.mapError(failure));
  const project = projectId ?? caller?.projectId;
  if (project === undefined) return yield* missingProject;
  return {
    projectId: project,
    workflows: yield* WorkflowStore.WorkflowStore,
    skills: yield* SkillWriter.SkillWriter,
  };
});

const encodeWorkflow = Schema.encodeSync(CommandCenterWorkflow);

const runSummary = (run: CommandCenterWorkflowRun) => ({
  id: run.id,
  slug: run.slug,
  status: run.status,
  startedAt: run.startedAt,
  finishedAt: run.finishedAt,
  error: run.error,
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
  section_update: McpToolAccess.writes(({ id, prUrl, ...patch }) =>
    Effect.gen(function* () {
      const { service } = yield* access;
      const pullRequest =
        prUrl === undefined
          ? {}
          : { prUrl, prNumber: prUrl === null ? null : pullRequestNumberFromUrl(prUrl) };
      return yield* service
        .patchSection(id, { ...patch, ...pullRequest })
        .pipe(Effect.mapError(failure));
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
  artifact_save: McpToolAccess.writes(({ htmlRenderId, projectId, content, ...input }) =>
    Effect.gen(function* () {
      const { caller, scope, artifacts } = yield* artifactAccess;
      // A new artifact lands in the calling thread's project unless told otherwise.
      const project =
        projectId === undefined && input.id === undefined ? (caller?.projectId ?? null) : projectId;
      const page =
        content === undefined
          ? undefined
          : yield* agentPage(artifacts, input, content, caller !== undefined);
      const saved = yield* artifacts
        .save(
          {
            ...input,
            ...(page === undefined ? {} : { content: page }),
            ...(htmlRenderId === undefined ? {} : { fromAttachmentId: htmlRenderId }),
            ...(project === undefined ? {} : { projectId: project }),
            ...(caller === undefined ? {} : { threadId: caller.id }),
          },
          {
            author: "agent",
            label: scope.thread?.providerInstanceId ?? scope.client?.label ?? null,
          },
        )
        .pipe(Effect.mapError(failure));
      return { id: saved.artifact.id, version: saved.version.version, title: saved.artifact.title };
    }),
  ),
  artifact_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller, artifacts } = yield* artifactAccess;
      const projectId = projectFilter(caller, input.projectId);
      const page = yield* artifacts
        .list({
          ...(projectId === null ? {} : { projectId }),
          ...(input.query === undefined ? {} : { query: input.query }),
          limit: input.limit ?? 20,
        })
        .pipe(Effect.mapError(failure));
      return {
        artifacts: page.artifacts.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          kind: artifact.kind,
          projectId: artifact.projectId,
          version: artifact.currentVersion,
          updatedAt: artifact.updatedAt,
        })),
        hasMore: page.hasMore,
      };
    }),
  ),
  artifact_get: McpToolAccess.reads(({ offset, ...input }) =>
    Effect.gen(function* () {
      const { artifacts } = yield* artifactAccess;
      const detail = yield* artifacts
        .get({ ...input, includeContent: true })
        .pipe(Effect.mapError(failure));
      // Inlined images become placeholders and the rest pages, so the agent's context stays small.
      const full = Artifacts.elideInlineData(detail.content ?? "").content;
      const start = Math.min(offset ?? 0, full.length);
      const end = start + ARTIFACT_GET_MAX_CHARS;
      return {
        id: detail.artifact.id,
        title: detail.artifact.title,
        kind: detail.artifact.kind,
        version: detail.version.version,
        currentVersion: detail.artifact.currentVersion,
        sizeBytes: detail.version.sizeBytes,
        content: full.slice(start, end),
        totalChars: full.length,
        truncated: end < full.length,
        nextOffset: end < full.length ? end : null,
      };
    }),
  ),
  workflow_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projectId, workflows } = yield* projectAccess(input.projectId);
      const listed = yield* workflows.list({ projectId }).pipe(Effect.mapError(failure));
      return {
        workflows: listed.workflows.map((workflow) => ({
          slug: workflow.slug,
          title: workflow.title,
          inputs: workflow.inputs.map((field) => field.name),
          nodeCount: workflow.nodeCount,
          error: workflow.error,
        })),
        starters: WORKFLOW_STARTERS.map((starter) => ({
          slug: starter.slug,
          title: starter.title,
        })),
      };
    }),
  ),
  workflow_get: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      if (input.starter === true) {
        const starter = WORKFLOW_STARTERS.find((candidate) => candidate.slug === input.slug);
        if (starter === undefined) return yield* invalid(`No starter named "${input.slug}".`);
        return { workflow: encodeWorkflow(starter), errors: [], raw: null };
      }
      const { projectId, workflows } = yield* projectAccess(input.projectId);
      const detail = yield* workflows
        .get({ projectId, slug: input.slug })
        .pipe(Effect.mapError(failure));
      return {
        workflow: detail.workflow === null ? null : encodeWorkflow(detail.workflow),
        errors: detail.errors,
        raw: detail.raw,
      };
    }),
  ),
  // Workflow and skill files steer every later agent, like any project file an agent writes, so
  // they need a full-access/default caller.
  workflow_save: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const { projectId, workflows } = yield* projectAccess(input.projectId);
      const parsed = parseCommandCenterWorkflow(input.workflow);
      if (parsed.workflow === null) {
        return yield* invalid(`Fix the workflow and save again: ${parsed.errors.join(" ")}`);
      }
      const saved = yield* workflows
        .save({ projectId, workflow: parsed.workflow })
        .pipe(Effect.mapError(failure));
      return { slug: saved.slug, updatedAt: saved.updatedAt };
    }),
  ),
  // The run's threads never run broader than the agent that started it.
  workflow_run: McpToolAccess.startsThreads(
    () => ({}),
    (input, modes) =>
      Effect.gen(function* () {
        const { caller } = yield* access;
        const projectId = input.projectId ?? caller?.projectId;
        if (projectId === undefined) return yield* missingProject;
        const runner = yield* WorkflowRunner.WorkflowRunner;
        const run = yield* runner
          .start(
            {
              projectId,
              slug: input.slug,
              ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
            },
            { modeLimit: modes },
          )
          .pipe(Effect.mapError(failure));
        return runSummary(run);
      }),
  ),
  workflow_answer: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      yield* access;
      const runner = yield* WorkflowRunner.WorkflowRunner;
      const run = yield* runner.answer(input).pipe(Effect.mapError(failure));
      return runSummary(run);
    }),
  ),
  workflow_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* access;
      const runner = yield* WorkflowRunner.WorkflowRunner;
      if (input.runId !== undefined) {
        const detail = yield* runner.get({ runId: input.runId }).pipe(Effect.mapError(failure));
        return {
          runs: [runSummary(detail.run)],
          steps: detail.steps.map((step) => ({
            nodeId: step.nodeId,
            item: step.item,
            attempt: step.attempt,
            status: step.status,
            threadId: step.threadId,
            output: step.output,
            error: step.error,
          })),
        };
      }
      const projectId = projectFilter(caller, input.projectId);
      const page = yield* runner
        .list({ ...(projectId === null ? {} : { projectId }), limit: 10 })
        .pipe(Effect.mapError(failure));
      return { runs: page.runs.map(runSummary), steps: [] };
    }),
  ),
  skill_create: McpToolAccess.writesEnvironment(({ projectId, ...input }) =>
    Effect.gen(function* () {
      const project = yield* projectAccess(projectId);
      const { skill } = yield* project.skills
        .create({ ...input, projectId: project.projectId })
        .pipe(Effect.mapError(failure));
      return { name: skill.name, inAgents: skill.inAgents, inClaude: skill.inClaude };
    }),
  ),
  skill_update: McpToolAccess.writesEnvironment(({ projectId, ...input }) =>
    Effect.gen(function* () {
      const project = yield* projectAccess(projectId);
      const { skill } = yield* project.skills
        .update({ ...input, projectId: project.projectId })
        .pipe(Effect.mapError(failure));
      return { name: skill.name, inAgents: skill.inAgents, inClaude: skill.inClaude };
    }),
  ),
  // A profile's modes are the modes its workflow steps run in, so an agent may not set them
  // broader than its own; a new profile takes the agent's modes instead of the server default.
  agent_profile_save: McpToolAccess.startsThreads(
    (input) => ({ runtimeMode: input.runtimeMode, interactionMode: input.interactionMode }),
    (input, modes) =>
      Effect.gen(function* () {
        const { service } = yield* access;
        const creating = input.id === undefined;
        const profile = yield* service
          .saveAgentProfile({
            ...input,
            ...(creating || input.runtimeMode !== undefined
              ? { runtimeMode: modes.runtimeMode }
              : {}),
            ...(creating || input.interactionMode !== undefined
              ? { interactionMode: modes.interactionMode }
              : {}),
          })
          .pipe(Effect.mapError(failure));
        return { id: profile.id, name: profile.name };
      }),
  ),
});
