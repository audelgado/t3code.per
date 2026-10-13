import {
  CommandCenterAgentId,
  CommandCenterAgentProfile,
  CommandCenterArtifactId,
  CommandCenterArtifactKind,
  CommandCenterMemoryEntry,
  CommandCenterMemoryId,
  CommandCenterMemoryKind,
  CommandCenterMemoryRecall,
  CommandCenterPullRequestUrl,
  CommandCenterSection,
  CommandCenterSectionId,
  CommandCenterSectionStatus,
  CommandCenterSkillName,
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowRunId,
  CommandCenterWorkflowRunStatus,
  CommandCenterWorkflowSlug,
  CommandCenterWorkflowStepStatus,
  ThreadId,
  NonNegativeInt,
  IsoDateTime,
  OrchestratorMcpFailure,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ArtifactsService from "../../../commandCenter/ArtifactsService.ts";
import * as CommandCenterService from "../../../commandCenter/CommandCenterService.ts";
import * as SkillWriter from "../../../commandCenter/SkillWriter.ts";
import * as WorkflowRunner from "../../../commandCenter/WorkflowRunner.ts";
import * as WorkflowStore from "../../../commandCenter/WorkflowStore.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CommandCenterService.CommandCenterService,
  ],
};

const ProjectFilter = Schema.optional(
  Schema.NullOr(ProjectId).annotate({
    description:
      "Project to scope to. Omit for the calling thread's project (every project when there is no calling thread); null for every project.",
  }),
);

const MemorySaveTool = Tool.make("memory_save", {
  ...shared,
  description:
    'Save an entry to the user\'s Command Center memory. Call it only when the user asks you to save, remember, note or keep something ("save this to memory", "remember that..."), or when your task instructions ask for it. Kinds: `progress` for where work was left, `todo` for something still open, `decision` for a choice and its reason, `handoff` for a note to the next team, `note` for anything else. Keep each entry short and self-contained.',
  parameters: Schema.Struct({
    kind: CommandCenterMemoryKind,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
    projectId: Schema.optional(
      ProjectId.annotate({
        description: "Project it belongs to. Omit for the calling thread's project.",
      }),
    ),
    sectionId: Schema.optional(
      CommandCenterSectionId.annotate({ description: "Section it belongs to, from section_list." }),
    ),
  }),
  success: CommandCenterMemoryEntry,
})
  .annotate(Tool.Title, "Save to memory")
  .annotate(Tool.Destructive, false);

const MemoryRecallTool = Tool.make("memory_recall", {
  ...shared,
  description:
    "Recall where work was left off: the latest progress entry per project, open todos (with ids for memory_complete), and recent decisions and handoffs, each clipped to a short text. Call it when the user asks what is pending or where things stand, or when your task instructions ask for it.",
  parameters: Schema.Struct({ projectId: ProjectFilter }),
  success: CommandCenterMemoryRecall,
})
  .annotate(Tool.Title, "Recall memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const MemoryCompleteTool = Tool.make("memory_complete", {
  ...shared,
  description:
    "Mark a memory todo as done (id from memory_recall). Call it when you finish something a todo describes. Pass done=false to reopen it.",
  parameters: Schema.Struct({
    id: CommandCenterMemoryId,
    done: Schema.optional(Schema.Boolean.annotate({ description: "Defaults to true." })),
  }),
  success: CommandCenterMemoryEntry,
})
  .annotate(Tool.Title, "Complete a memory todo")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SectionListTool = Tool.make("section_list", {
  ...shared,
  description:
    "List the sections (workstreams) of a project in the Command Center, with status, task counts, due date, what is being tried, blocker and what is missing. Use the returned id with section_update or memory_save.",
  parameters: Schema.Struct({ projectId: ProjectFilter }),
  success: Schema.Struct({ sections: Schema.Array(CommandCenterSection) }),
})
  .annotate(Tool.Title, "List project sections")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DependsOnField = CommandCenterSection.fields.dependsOn.annotate({
  description: "Ids (from section_list, any project) of sections this one waits on.",
});

const SectionUpdateTool = Tool.make("section_update", {
  ...shared,
  description:
    "Update a project section (id from section_list) as work moves: status, task counts, due date, what you are trying, the blocker, what is missing, the sections it waits on, or the pull request that delivers it. Omitted fields keep their value; pass null to clear dueDate, trying, blocker or prUrl.",
  parameters: Schema.Struct({
    id: CommandCenterSectionId,
    name: Schema.optionalKey(CommandCenterSection.fields.name),
    status: Schema.optionalKey(CommandCenterSectionStatus),
    tasksDone: Schema.optionalKey(NonNegativeInt),
    tasksTotal: Schema.optionalKey(NonNegativeInt),
    dueDate: Schema.optionalKey(CommandCenterSection.fields.dueDate),
    trying: Schema.optionalKey(CommandCenterSection.fields.trying),
    blocker: Schema.optionalKey(CommandCenterSection.fields.blocker),
    missing: Schema.optionalKey(CommandCenterSection.fields.missing),
    dependsOn: Schema.optionalKey(DependsOnField),
    prUrl: Schema.optionalKey(Schema.NullOr(CommandCenterPullRequestUrl)),
  }),
  success: CommandCenterSection,
})
  .annotate(Tool.Title, "Update a project section")
  .annotate(Tool.Destructive, false);

const SectionCreateTool = Tool.make("section_create", {
  ...shared,
  description:
    "Create a section (a workstream such as Checkout or Auth) in a project. If the project already has a section with that name (any case) it is returned unchanged, so check section_list and use section_update to change existing ones. Use it when organizing a project's work, for example during onboarding.",
  parameters: Schema.Struct({
    name: CommandCenterSection.fields.name,
    projectId: Schema.optional(
      ProjectId.annotate({
        description: "Project it belongs to. Omit for the calling thread's project.",
      }),
    ),
    status: Schema.optionalKey(
      CommandCenterSectionStatus.annotate({ description: "Defaults to todo." }),
    ),
    tasksDone: Schema.optionalKey(NonNegativeInt),
    tasksTotal: Schema.optionalKey(NonNegativeInt),
    dueDate: Schema.optionalKey(CommandCenterSection.fields.dueDate),
    trying: Schema.optionalKey(CommandCenterSection.fields.trying),
    blocker: Schema.optionalKey(CommandCenterSection.fields.blocker),
    missing: Schema.optionalKey(CommandCenterSection.fields.missing),
    dependsOn: Schema.optionalKey(DependsOnField),
  }),
  success: CommandCenterSection,
})
  .annotate(Tool.Title, "Create a project section")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ProjectDigestTool = Tool.make("project_digest", {
  ...shared,
  description:
    "Return the project's repo digest: a zero-token scan of its file tree, languages, manifests and scripts, README headings, git history, TODO/FIXME/HACK lines and open GitHub issues. Built on first use and then cached; call it before reading files so you only open the ones it points at.",
  parameters: Schema.Struct({
    projectId: Schema.optional(
      ProjectId.annotate({ description: "Omit for the calling thread's project." }),
    ),
  }),
  success: CommandCenterMemoryEntry,
})
  .annotate(Tool.Title, "Read the project digest")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

/** Characters artifact_get returns per call, well inside providers' tool-result limits. */
export const ARTIFACT_GET_MAX_CHARS = 60_000;

const artifactShared = {
  ...shared,
  dependencies: [...shared.dependencies, ArtifactsService.ArtifactsService],
};

const ArtifactSaveTool = Tool.make("artifact_save", {
  ...artifactShared,
  dependencies: [...artifactShared.dependencies, HtmlRender.HtmlRender],
  description:
    "Save an HTML or Markdown page to the user's Command Center artifacts library, shared across agents and versioned. Call it only when the user asks to save or keep a page, or your task instructions ask for it. Omit id to create one (title required); pass an id from artifact_list to add a version. To save a page you showed with html_render, pass its htmlRender.attachmentId as htmlRenderId instead of content. In HTML content, local images given as absolute paths are inlined as with html_render, and the data:t3-inline/<n> placeholders artifact_get returns are put back from the current version.",
  parameters: Schema.Struct({
    id: Schema.optional(CommandCenterArtifactId),
    title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    kind: Schema.optional(
      CommandCenterArtifactKind.annotate({ description: "On create; defaults to html." }),
    ),
    content: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    htmlRenderId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    projectId: Schema.optional(
      Schema.NullOr(ProjectId).annotate({
        description:
          "On create, omit for the calling thread's project, null for none. On a new version, omit to keep it.",
      }),
    ),
  }),
  success: Schema.Struct({
    id: CommandCenterArtifactId,
    version: PositiveInt,
    title: TrimmedNonEmptyString,
  }),
})
  .annotate(Tool.Title, "Save an artifact")
  .annotate(Tool.Destructive, false);

const ArtifactListTool = Tool.make("artifact_list", {
  ...artifactShared,
  description:
    "List artifacts in the user's Command Center library, most recently updated first. Use an id with artifact_get or artifact_save.",
  parameters: Schema.Struct({
    projectId: ProjectFilter,
    query: Schema.optional(
      TrimmedString.check(Schema.isMaxLength(200)).annotate({ description: "Title contains." }),
    ),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: "Defaults to 20.",
      }),
    ),
  }),
  success: Schema.Struct({
    artifacts: Schema.Array(
      Schema.Struct({
        id: CommandCenterArtifactId,
        title: TrimmedNonEmptyString,
        kind: CommandCenterArtifactKind,
        projectId: Schema.NullOr(ProjectId),
        version: PositiveInt,
        updatedAt: IsoDateTime,
      }),
    ),
    hasMore: Schema.Boolean,
  }),
})
  .annotate(Tool.Title, "List artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ArtifactGetTool = Tool.make("artifact_get", {
  ...artifactShared,
  description: `Read an artifact's content (id from artifact_list), the current version by default. Inlined images come back as data:t3-inline/<n> placeholders; keep them as they are when you save a revision. At most ${ARTIFACT_GET_MAX_CHARS} characters come back per call: when truncated is true, call again with offset set to nextOffset.`,
  parameters: Schema.Struct({
    id: CommandCenterArtifactId,
    version: Schema.optional(PositiveInt),
    offset: Schema.optional(
      NonNegativeInt.annotate({ description: "Character to start from; defaults to 0." }),
    ),
  }),
  success: Schema.Struct({
    id: CommandCenterArtifactId,
    title: TrimmedNonEmptyString,
    kind: CommandCenterArtifactKind,
    version: PositiveInt,
    currentVersion: PositiveInt,
    sizeBytes: NonNegativeInt,
    content: Schema.String,
    totalChars: NonNegativeInt,
    truncated: Schema.Boolean,
    nextOffset: Schema.NullOr(NonNegativeInt),
  }),
})
  .annotate(Tool.Title, "Read an artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// Wave 5 workflows. Workflow and skill files live in the project, so these tools work on the
// machine that has it; runs and agent profiles live in Command Center, so those need its home.

const workflowShared = {
  ...shared,
  dependencies: [
    ...shared.dependencies,
    WorkflowStore.WorkflowStore,
    SkillWriter.SkillWriter,
    WorkflowRunner.WorkflowRunner,
  ],
};

const ProjectField = Schema.optional(
  ProjectId.annotate({ description: "Omit for the calling thread's project." }),
);

const WorkflowListTool = Tool.make("workflow_list", {
  ...workflowShared,
  description:
    "List the project's workflows (`.t3/workflows/*.json`) and the built-in starters. A workflow with an error cannot run until fixed with workflow_save.",
  parameters: Schema.Struct({ projectId: ProjectField }),
  success: Schema.Struct({
    workflows: Schema.Array(
      Schema.Struct({
        slug: CommandCenterWorkflowSlug,
        title: Schema.String,
        inputs: Schema.Array(Schema.String),
        nodeCount: NonNegativeInt,
        error: Schema.NullOr(Schema.String),
      }),
    ),
    starters: Schema.Array(
      Schema.Struct({ slug: CommandCenterWorkflowSlug, title: Schema.String }),
    ),
  }),
})
  .annotate(Tool.Title, "List workflows")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkflowGetTool = Tool.make("workflow_get", {
  ...workflowShared,
  description:
    "Read a workflow as JSON (slug from workflow_list). A broken file comes back with its errors and raw text. Pass starter=true to read a built-in starter, then workflow_save it to copy it into the project.",
  parameters: Schema.Struct({
    slug: CommandCenterWorkflowSlug,
    projectId: ProjectField,
    starter: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    workflow: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
    errors: Schema.Array(Schema.String),
    raw: Schema.NullOr(Schema.String),
  }),
})
  .annotate(Tool.Title, "Read a workflow")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkflowSaveTool = Tool.make("workflow_save", {
  ...workflowShared,
  description:
    "Create or replace the project's `.t3/workflows/<slug>.json`. Call it only when the user asks for a workflow. Format: {slug (kebab-case), title, description?, inputs?: [{name, label, default?}], nodes, edges?: [{from, to}]}. Every node has id, kind and title?; kinds: agent {prompt, profile? (agent profile id), skills?, worktree?, outputs?: text|memory|artifact}, skill {skill, args?}, ask {question, choices?}, parallel {over: input name or node id, node: an agent or skill node run per item, with no edges of its own}, gate {check: tests|typecheck|manual}. Edges run `to` after `from` and must not loop. Prompts may use {{input:name}} and {{snippet:name}}. Invalid workflows come back as errors to fix.",
  parameters: Schema.Struct({
    workflow: Schema.Record(Schema.String, Schema.Unknown),
    projectId: ProjectField,
  }),
  success: Schema.Struct({ slug: CommandCenterWorkflowSlug, updatedAt: IsoDateTime }),
})
  .annotate(Tool.Title, "Save a workflow")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const RunSummary = Schema.Struct({
  id: CommandCenterWorkflowRunId,
  slug: CommandCenterWorkflowSlug,
  status: CommandCenterWorkflowRunStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});

const WorkflowRunTool = Tool.make("workflow_run", {
  ...workflowShared,
  description:
    "Start a run of a project workflow (or a built-in starter the project has not saved). Call it only when the user asks. Inputs are by name; omitted ones take their default. Steps run no broader than your own modes. Follow it with workflow_status.",
  parameters: Schema.Struct({
    slug: CommandCenterWorkflowSlug,
    projectId: ProjectField,
    inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  success: RunSummary,
})
  .annotate(Tool.Title, "Run a workflow")
  .annotate(Tool.Destructive, false);

const WorkflowAnswerTool = Tool.make("workflow_answer", {
  ...workflowShared,
  description:
    "Answer a run's waiting ask step, or approve or reject its waiting manual gate (status waiting in workflow_status). Call it only with the user's answer. With choices, the first continues the run and any other stops it there.",
  parameters: Schema.Struct({
    runId: CommandCenterWorkflowRunId,
    nodeId: CommandCenterWorkflowNodeId,
    answer: Schema.optional(
      TrimmedString.check(Schema.isMaxLength(2_000)).annotate({
        description:
          "The ask's answer (one of its choices when it has them), or a note on the gate.",
      }),
    ),
    approved: Schema.optional(
      Schema.Boolean.annotate({ description: "Manual gates only: true passes, false fails." }),
    ),
  }),
  success: RunSummary,
})
  .annotate(Tool.Title, "Answer a workflow step")
  .annotate(Tool.Destructive, false);

const WorkflowStatusTool = Tool.make("workflow_status", {
  ...workflowShared,
  description:
    "With runId, a run and its steps; without, the latest runs of the project (projectId null for every project).",
  parameters: Schema.Struct({
    runId: Schema.optional(CommandCenterWorkflowRunId),
    projectId: ProjectFilter,
  }),
  success: Schema.Struct({
    runs: Schema.Array(RunSummary),
    steps: Schema.Array(
      Schema.Struct({
        nodeId: CommandCenterWorkflowNodeId,
        item: Schema.NullOr(NonNegativeInt),
        attempt: PositiveInt,
        status: CommandCenterWorkflowStepStatus,
        threadId: Schema.NullOr(ThreadId),
        output: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})
  .annotate(Tool.Title, "Workflow run status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const SkillFields = {
  name: CommandCenterSkillName,
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
    description: "When to use the skill, in a sentence or two.",
  }),
  content: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)).annotate({
    description: "Markdown instructions, without frontmatter.",
  }),
  projectId: ProjectField,
};
const SkillResult = Schema.Struct({
  name: CommandCenterSkillName,
  inAgents: Schema.Boolean,
  inClaude: Schema.Boolean,
});

const SkillCreateTool = Tool.make("skill_create", {
  ...workflowShared,
  description:
    "Create a project skill: writes SKILL.md to `.agents/skills/<name>/` and `.claude/skills/<name>/` so every provider sees it. Call it only when the user asks. Fails if the name exists; use skill_update.",
  parameters: Schema.Struct(SkillFields),
  success: SkillResult,
})
  .annotate(Tool.Title, "Create a skill")
  .annotate(Tool.Destructive, false);

const SkillUpdateTool = Tool.make("skill_update", {
  ...workflowShared,
  description: "Replace an existing project skill's description and content, in both folders.",
  parameters: Schema.Struct(SkillFields),
  success: SkillResult,
})
  .annotate(Tool.Title, "Update a skill")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const profileFields = CommandCenterAgentProfile.fields;

const AgentProfileSaveTool = Tool.make("agent_profile_save", {
  ...workflowShared,
  description:
    "Create (omit id; name required) or edit a Command Center agent profile that workflow agent nodes reference. Call it only when the user asks. Omitted fields keep their value, or take the server defaults on create.",
  parameters: Schema.Struct({
    id: Schema.optionalKey(CommandCenterAgentId),
    name: Schema.optionalKey(profileFields.name),
    role: Schema.optionalKey(profileFields.role),
    rolePrompt: Schema.optionalKey(profileFields.rolePrompt),
    modelSelection: Schema.optionalKey(profileFields.modelSelection),
    runtimeMode: Schema.optionalKey(profileFields.runtimeMode),
    interactionMode: Schema.optionalKey(profileFields.interactionMode),
    teamId: Schema.optionalKey(profileFields.teamId),
  }),
  success: Schema.Struct({ id: CommandCenterAgentId, name: Schema.String }),
})
  .annotate(Tool.Title, "Save an agent profile")
  .annotate(Tool.Destructive, false);

export const CommandCenterToolkit = Toolkit.make(
  MemorySaveTool,
  MemoryRecallTool,
  MemoryCompleteTool,
  SectionListTool,
  SectionUpdateTool,
  SectionCreateTool,
  ProjectDigestTool,
  ArtifactSaveTool,
  ArtifactListTool,
  ArtifactGetTool,
  WorkflowListTool,
  WorkflowGetTool,
  WorkflowSaveTool,
  WorkflowRunTool,
  WorkflowAnswerTool,
  WorkflowStatusTool,
  SkillCreateTool,
  SkillUpdateTool,
  AgentProfileSaveTool,
);
