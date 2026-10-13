import {
  CommandCenterMemoryEntry,
  CommandCenterMemoryId,
  CommandCenterMemoryKind,
  CommandCenterMemoryRecall,
  CommandCenterSection,
  CommandCenterSectionId,
  CommandCenterSectionStatus,
  NonNegativeInt,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CommandCenterService from "../../../commandCenter/CommandCenterService.ts";
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
    "Update a project section (id from section_list) as work moves: status, task counts, due date, what you are trying, the blocker, what is missing, or the sections it waits on. Omitted fields keep their value; pass null to clear dueDate, trying or blocker.",
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

export const CommandCenterToolkit = Toolkit.make(
  MemorySaveTool,
  MemoryRecallTool,
  MemoryCompleteTool,
  SectionListTool,
  SectionUpdateTool,
  SectionCreateTool,
  ProjectDigestTool,
);
