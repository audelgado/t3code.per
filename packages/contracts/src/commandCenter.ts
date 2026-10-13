import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

// Command Center: agent teams, project sections, memory and finance, stored in
// the primary environment. See docs/command-center/SPEC.md.

const id = <Brand extends string>(brand: Parameters<typeof Schema.brand<Brand>>[0]) =>
  TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

export const CommandCenterAgentId = id("CommandCenterAgentId");
export type CommandCenterAgentId = typeof CommandCenterAgentId.Type;
export const CommandCenterTeamId = id("CommandCenterTeamId");
export type CommandCenterTeamId = typeof CommandCenterTeamId.Type;
export const CommandCenterAssignmentId = id("CommandCenterAssignmentId");
export type CommandCenterAssignmentId = typeof CommandCenterAssignmentId.Type;
export const CommandCenterSectionId = id("CommandCenterSectionId");
export type CommandCenterSectionId = typeof CommandCenterSectionId.Type;
export const CommandCenterMemoryId = id("CommandCenterMemoryId");
export type CommandCenterMemoryId = typeof CommandCenterMemoryId.Type;
export const CommandCenterIncomeId = id("CommandCenterIncomeId");
export type CommandCenterIncomeId = typeof CommandCenterIncomeId.Type;
export const CommandCenterCostId = id("CommandCenterCostId");
export type CommandCenterCostId = typeof CommandCenterCostId.Type;

/** Fixed ids of the built-in Onboarding team, so ensuring it is idempotent and clients can spot it. */
export const COMMAND_CENTER_ONBOARDING_TEAM_ID = CommandCenterTeamId.make("cc-team:onboarding");
export const COMMAND_CENTER_ONBOARDING_LEAD_ID = CommandCenterAgentId.make(
  "cc-agent:onboarding-lead",
);

/** Calendar day, `YYYY-MM-DD`. */
export const CommandCenterDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
/** ISO 4217 code such as `USD`. */
export const CommandCenterCurrency = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/));
/** Money is always integer cents. */
export const CommandCenterCents = NonNegativeInt;
const ShortText = TrimmedString.check(Schema.isMaxLength(2_000));
const LongText = TrimmedString.check(Schema.isMaxLength(20_000));
const Name = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

export const CommandCenterSectionStatus = Schema.Literals([
  "todo",
  "in_progress",
  "review",
  "blocked",
  "done",
]);
export type CommandCenterSectionStatus = typeof CommandCenterSectionStatus.Type;

export const CommandCenterMemoryKind = Schema.Literals([
  "progress",
  "decision",
  "todo",
  "handoff",
  "note",
]);
export type CommandCenterMemoryKind = typeof CommandCenterMemoryKind.Type;

export const CommandCenterMemorySource = Schema.Literals(["user", "agent", "system"]);
export type CommandCenterMemorySource = typeof CommandCenterMemorySource.Type;

export const CommandCenterIncomeStatus = Schema.Literals(["pending", "paid", "overdue"]);
export type CommandCenterIncomeStatus = typeof CommandCenterIncomeStatus.Type;

// Each entity is `{ id, ...editable fields, timestamps }`. Upserts send `{ id?, ...editable }`
// and replace every editable field; timestamps are owned by the server.

const AgentProfileFields = {
  name: Name,
  avatar: Schema.NullOr(ShortText),
  role: ShortText,
  rolePrompt: LongText,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  teamId: Schema.NullOr(CommandCenterTeamId),
  sortKey: Schema.Int,
};

const TeamFields = {
  name: Name,
  color: ShortText,
  leadAgentId: Schema.NullOr(CommandCenterAgentId),
  /** Machine the team runs on; null means the primary environment. */
  environmentId: Schema.NullOr(EnvironmentId),
  sortKey: Schema.Int,
};

const AssignmentFields = {
  agentId: CommandCenterAgentId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId,
  sectionId: Schema.NullOr(CommandCenterSectionId),
  task: LongText,
  finishedAt: Schema.NullOr(IsoDateTime),
};

const SectionFields = {
  projectId: ProjectId,
  name: Name,
  status: CommandCenterSectionStatus,
  tasksDone: NonNegativeInt,
  tasksTotal: NonNegativeInt,
  dueDate: Schema.NullOr(CommandCenterDate),
  trying: Schema.NullOr(ShortText),
  blocker: Schema.NullOr(ShortText),
  missing: Schema.Array(ShortText),
  sortKey: Schema.Int,
};

const MemoryFields = {
  projectId: Schema.NullOr(ProjectId),
  sectionId: Schema.NullOr(CommandCenterSectionId),
  threadId: Schema.NullOr(ThreadId),
  kind: CommandCenterMemoryKind,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  /** Only meaningful for `todo`. */
  done: Schema.Boolean,
  source: CommandCenterMemorySource,
};

const IncomeFields = {
  concept: Name,
  clientName: Name,
  date: CommandCenterDate,
  amountCents: CommandCenterCents,
  currency: CommandCenterCurrency,
  status: CommandCenterIncomeStatus,
};

const CostFields = {
  concept: Name,
  category: ShortText,
  monthlyCents: CommandCenterCents,
  currency: CommandCenterCurrency,
  /** Projects this cost supports; the monthly amount is split evenly between them. */
  projectIds: Schema.Array(ProjectId),
};

const timestamps = { createdAt: IsoDateTime, updatedAt: IsoDateTime };
/** Archived rows stay in the snapshot so history (assignments, past months' costs) still resolves. */
const archivable = { ...timestamps, archivedAt: Schema.NullOr(IsoDateTime) };

export const CommandCenterAgentProfile = Schema.Struct({
  id: CommandCenterAgentId,
  ...AgentProfileFields,
  ...archivable,
});
export type CommandCenterAgentProfile = typeof CommandCenterAgentProfile.Type;

export const CommandCenterTeam = Schema.Struct({
  id: CommandCenterTeamId,
  ...TeamFields,
  ...archivable,
});
export type CommandCenterTeam = typeof CommandCenterTeam.Type;

export const CommandCenterAssignment = Schema.Struct({
  id: CommandCenterAssignmentId,
  ...AssignmentFields,
  createdAt: IsoDateTime,
});
export type CommandCenterAssignment = typeof CommandCenterAssignment.Type;

/** Sections (of any project) this one waits on. */
const SectionDependsOn = Schema.Array(CommandCenterSectionId).check(Schema.isMaxLength(50));

export const CommandCenterSection = Schema.Struct({
  id: CommandCenterSectionId,
  ...SectionFields,
  dependsOn: SectionDependsOn,
  ...timestamps,
});
export type CommandCenterSection = typeof CommandCenterSection.Type;

export const CommandCenterMemoryEntry = Schema.Struct({
  id: CommandCenterMemoryId,
  ...MemoryFields,
  ...timestamps,
});
export type CommandCenterMemoryEntry = typeof CommandCenterMemoryEntry.Type;

export const CommandCenterIncome = Schema.Struct({
  id: CommandCenterIncomeId,
  ...IncomeFields,
  ...timestamps,
});
export type CommandCenterIncome = typeof CommandCenterIncome.Type;

export const CommandCenterCost = Schema.Struct({
  id: CommandCenterCostId,
  ...CostFields,
  ...archivable,
});
export type CommandCenterCost = typeof CommandCenterCost.Type;

export const CommandCenterEntity = Schema.Literals([
  "agentProfile",
  "team",
  "assignment",
  "section",
  "memory",
  "income",
  "cost",
]);
export type CommandCenterEntity = typeof CommandCenterEntity.Type;

/** One stored row of any entity, tagged by `entity`. */
export const CommandCenterRecord = Schema.Union([
  Schema.Struct({ entity: Schema.Literal("agentProfile"), value: CommandCenterAgentProfile }),
  Schema.Struct({ entity: Schema.Literal("team"), value: CommandCenterTeam }),
  Schema.Struct({ entity: Schema.Literal("assignment"), value: CommandCenterAssignment }),
  Schema.Struct({ entity: Schema.Literal("section"), value: CommandCenterSection }),
  Schema.Struct({ entity: Schema.Literal("memory"), value: CommandCenterMemoryEntry }),
  Schema.Struct({ entity: Schema.Literal("income"), value: CommandCenterIncome }),
  Schema.Struct({ entity: Schema.Literal("cost"), value: CommandCenterCost }),
]);
export type CommandCenterRecord = typeof CommandCenterRecord.Type;

/** Upsert payload: omit `id` to create. Every editable field is replaced. Upserting an archived row restores it. */
export const CommandCenterUpsertInput = Schema.Union([
  Schema.Struct({
    entity: Schema.Literal("agentProfile"),
    value: Schema.Struct({ id: Schema.optional(CommandCenterAgentId), ...AgentProfileFields }),
  }),
  Schema.Struct({
    entity: Schema.Literal("team"),
    value: Schema.Struct({ id: Schema.optional(CommandCenterTeamId), ...TeamFields }),
  }),
  Schema.Struct({
    entity: Schema.Literal("assignment"),
    value: Schema.Struct({ id: Schema.optional(CommandCenterAssignmentId), ...AssignmentFields }),
  }),
  Schema.Struct({
    entity: Schema.Literal("section"),
    value: Schema.Struct({
      id: Schema.optional(CommandCenterSectionId),
      ...SectionFields,
      /** Omitted keeps the stored dependencies (none on create). */
      dependsOn: Schema.optionalKey(SectionDependsOn),
    }),
  }),
  Schema.Struct({
    entity: Schema.Literal("memory"),
    value: Schema.Struct({ id: Schema.optional(CommandCenterMemoryId), ...MemoryFields }),
  }),
  Schema.Struct({
    entity: Schema.Literal("income"),
    value: Schema.Struct({ id: Schema.optional(CommandCenterIncomeId), ...IncomeFields }),
  }),
  Schema.Struct({
    entity: Schema.Literal("cost"),
    value: Schema.Struct({ id: Schema.optional(CommandCenterCostId), ...CostFields }),
  }),
]);
export type CommandCenterUpsertInput = typeof CommandCenterUpsertInput.Type;

/** Agent profiles, teams and costs are archived (and emitted as an upsert); everything else is removed. */
export const CommandCenterDeleteInput = Schema.Struct({
  entity: CommandCenterEntity,
  id: TrimmedNonEmptyString,
});
export type CommandCenterDeleteInput = typeof CommandCenterDeleteInput.Type;

export const CommandCenterSetMemoryDoneInput = Schema.Struct({
  id: CommandCenterMemoryId,
  done: Schema.Boolean,
});
export type CommandCenterSetMemoryDoneInput = typeof CommandCenterSetMemoryDoneInput.Type;

/**
 * Everything the Command Center shows, capped to stay small: memory holds the 200 newest open
 * todos plus the 100 newest entries (older ones page in through `commandCenter.listMemory`),
 * assignments every open one (at most one per agent) plus the 50 most recently finished, income
 * the last 13 months. The `summary` scope leaves memory, income and costs empty.
 */
export const CommandCenterSnapshot = Schema.Struct({
  agentProfiles: Schema.Array(CommandCenterAgentProfile),
  teams: Schema.Array(CommandCenterTeam),
  assignments: Schema.Array(CommandCenterAssignment),
  sections: Schema.Array(CommandCenterSection),
  memory: Schema.Array(CommandCenterMemoryEntry),
  income: Schema.Array(CommandCenterIncome),
  costs: Schema.Array(CommandCenterCost),
});
export type CommandCenterSnapshot = typeof CommandCenterSnapshot.Type;

export const CommandCenterSubscribeInput = Schema.Struct({
  /** `summary` skips memory, income and costs (snapshot and changes), for read-only status views. */
  scope: Schema.optional(Schema.Literal("summary")),
});
export type CommandCenterSubscribeInput = typeof CommandCenterSubscribeInput.Type;

/** `subscribeCommandCenter` emits one `snapshot`, then `upserted` / `deleted` changes. */
export const CommandCenterStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: CommandCenterSnapshot }),
  Schema.Struct({ type: Schema.Literal("upserted"), record: CommandCenterRecord }),
  Schema.Struct({
    type: Schema.Literal("deleted"),
    entity: CommandCenterEntity,
    id: TrimmedNonEmptyString,
  }),
]);
export type CommandCenterStreamEvent = typeof CommandCenterStreamEvent.Type;

export const CommandCenterMemoryRecallInput = Schema.Struct({
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type CommandCenterMemoryRecallInput = typeof CommandCenterMemoryRecallInput.Type;

/**
 * "Where we left off" for one project, or for every project when none is given. Each entry's
 * text is clipped so a long note never costs an agent much context; the full text stays in
 * Command Center.
 */
export const CommandCenterMemoryRecall = Schema.Struct({
  /**
   * Latest agent or user progress per project, newest first, then each project's latest daily
   * digest (source system).
   */
  progress: Schema.Array(CommandCenterMemoryEntry),
  /** Open todos, oldest first. */
  openTodos: Schema.Array(CommandCenterMemoryEntry),
  /** Most recent decisions, newest first. */
  decisions: Schema.Array(CommandCenterMemoryEntry),
  /** Most recent handoffs, newest first. */
  handoffs: Schema.Array(CommandCenterMemoryEntry),
});
export type CommandCenterMemoryRecall = typeof CommandCenterMemoryRecall.Type;

/** One page of memory, newest first, for history older than the snapshot holds. */
export const CommandCenterListMemoryInput = Schema.Struct({
  /** Only entries older than this one. Omit for the newest page. */
  before: Schema.optional(CommandCenterMemoryId),
  /**
   * `createdAt` of `before`. Pass it so paging keeps working when that entry was deleted
   * meanwhile; without it the server looks the entry up.
   */
  beforeCreatedAt: Schema.optional(IsoDateTime),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  projectId: Schema.optional(ProjectId),
  kind: Schema.optional(CommandCenterMemoryKind),
});
export type CommandCenterListMemoryInput = typeof CommandCenterListMemoryInput.Type;

export const CommandCenterListMemoryResult = Schema.Struct({
  entries: Schema.Array(CommandCenterMemoryEntry),
  /** Whether older entries remain; page on with the last entry's id as `before`. */
  hasMore: Schema.Boolean,
});
export type CommandCenterListMemoryResult = typeof CommandCenterListMemoryResult.Type;

export const CommandCenterListSectionsInput = Schema.Struct({
  /** Omit for every project. */
  projectId: Schema.optional(ProjectId),
});
export type CommandCenterListSectionsInput = typeof CommandCenterListSectionsInput.Type;

export const CommandCenterListSectionsResult = Schema.Struct({
  sections: Schema.Array(CommandCenterSection),
});
export type CommandCenterListSectionsResult = typeof CommandCenterListSectionsResult.Type;

export const CommandCenterBuildRepoDigestInput = Schema.Struct({ projectId: ProjectId });
export type CommandCenterBuildRepoDigestInput = typeof CommandCenterBuildRepoDigestInput.Type;

/** The built-in Onboarding team (Lead, Scout, Organizer); ordinary, editable rows. */
export const CommandCenterOnboardingTeam = Schema.Struct({
  team: CommandCenterTeam,
  agents: Schema.Array(CommandCenterAgentProfile),
});
export type CommandCenterOnboardingTeam = typeof CommandCenterOnboardingTeam.Type;

export class CommandCenterError extends Schema.TaggedError<CommandCenterError>()(
  "CommandCenterError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
