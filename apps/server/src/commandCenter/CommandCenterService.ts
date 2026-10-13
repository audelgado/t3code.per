import {
  CommandCenterError,
  CommandCenterListMemoryResult,
  CommandCenterMemoryEntry,
  CommandCenterMemoryRecall,
  type CommandCenterOnboardingTeam,
  CommandCenterRecord,
  CommandCenterSection,
  type CommandCenterSectionId,
  CommandCenterSnapshot,
  type CommandCenterDeleteInput,
  type CommandCenterEntity,
  type CommandCenterListMemoryInput,
  type CommandCenterMemoryRecallInput,
  type CommandCenterListSectionsResult,
  type CommandCenterSetMemoryDoneInput,
  type CommandCenterStreamEvent,
  type CommandCenterSubscribeInput,
  type CommandCenterUpsertInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { onboardingPreset } from "./onboarding.ts";
import { REPO_DIGEST_PREFIX, collectRepoDigest } from "./repoDigest.ts";
import { ensureCommandCenterSchema } from "./schema.ts";

type SectionValue = Extract<CommandCenterUpsertInput, { entity: "section" }>["value"];

/** Fields an agent may change on an existing section; omitted ones keep their value. */
export type CommandCenterSectionPatch = Partial<
  Pick<
    CommandCenterSection,
    | "name"
    | "status"
    | "tasksDone"
    | "tasksTotal"
    | "dueDate"
    | "trying"
    | "blocker"
    | "missing"
    | "dependsOn"
  >
>;

export class CommandCenterService extends Context.Service<
  CommandCenterService,
  {
    readonly getSnapshot: () => Effect.Effect<CommandCenterSnapshot, CommandCenterError>;
    /**
     * Emits one `snapshot`, then an `upserted` or `deleted` event for every later change.
     * Fails when `commandCenter.enabled` is off. A full subscription marks this machine as the
     * Command Center home (see `checkAgentAccess`).
     */
    readonly subscribe: (
      input?: CommandCenterSubscribeInput,
    ) => Stream.Stream<CommandCenterStreamEvent, CommandCenterError>;
    /**
     * Gate for agent (MCP) access. Fails when Command Center is off, or when this machine is not
     * where the user keeps Command Center: nobody opened it here and it has no teams or agents.
     * That is a remote machine running delegated threads, whose writes would land in a store no
     * client reads.
     */
    readonly checkAgentAccess: () => Effect.Effect<void, CommandCenterError>;
    /**
     * Creates (no `id`) or replaces a row. Upserting an archived row restores it. Recording an
     * open assignment finishes the agent's other open ones: an agent works on one thing.
     */
    readonly upsert: (
      input: CommandCenterUpsertInput,
    ) => Effect.Effect<CommandCenterRecord, CommandCenterError>;
    /**
     * Archives agent profiles (finishing their open assignments), teams and costs; removes
     * everything else. Missing ids are a no-op.
     */
    readonly delete: (input: CommandCenterDeleteInput) => Effect.Effect<void, CommandCenterError>;
    /** Closes or reopens a memory todo. */
    readonly setMemoryDone: (
      input: CommandCenterSetMemoryDoneInput,
    ) => Effect.Effect<CommandCenterMemoryEntry, CommandCenterError>;
    /**
     * "Where we left off": latest agent progress per project, then each project's latest daily
     * digest, open todos, recent decisions and handoffs, each text clipped to stay cheap.
     */
    readonly recallMemory: (
      input: CommandCenterMemoryRecallInput,
    ) => Effect.Effect<CommandCenterMemoryRecall, CommandCenterError>;
    /** Memory older than the snapshot holds, newest first, one page at a time. */
    readonly listMemory: (
      input: CommandCenterListMemoryInput,
    ) => Effect.Effect<CommandCenterListMemoryResult, CommandCenterError>;
    /** Sections of one project (or every project for null), in display order. */
    readonly listSections: (
      projectId: ProjectId | null,
    ) => Effect.Effect<CommandCenterListSectionsResult, CommandCenterError>;
    /** Creates a section, or returns the project's section with the same name (any case). */
    readonly createSection: (
      value: Omit<SectionValue, "id">,
    ) => Effect.Effect<CommandCenterSection, CommandCenterError>;
    /** Changes only the given fields in one statement, so concurrent edits never undo each other. */
    readonly patchSection: (
      id: CommandCenterSectionId,
      patch: CommandCenterSectionPatch,
    ) => Effect.Effect<CommandCenterSection, CommandCenterError>;
    /** Scans the project's repo without an LLM and saves it as its single digest `note`. */
    readonly buildRepoDigest: (
      projectId: ProjectId,
    ) => Effect.Effect<CommandCenterMemoryEntry, CommandCenterError>;
    /** The saved digest, built first when the project has none. */
    readonly getRepoDigest: (
      projectId: ProjectId,
    ) => Effect.Effect<CommandCenterMemoryEntry, CommandCenterError>;
    /** Creates the Onboarding team when missing, restores it when archived, keeps user edits. */
    readonly ensureOnboardingTeam: () => Effect.Effect<
      CommandCenterOnboardingTeam,
      CommandCenterError
    >;
    /**
     * The daily tick: prunes old finished assignments and done todos, then writes yesterday's
     * zero-token digest per active project. Idempotent per day; a no-op while disabled.
     * Returns whether it ran.
     */
    readonly runDailyMaintenance: () => Effect.Effect<boolean, CommandCenterError>;
  }
>()("t3/commandCenter/CommandCenterService") {}

const TABLES = {
  agentProfile: "cc_agent_profiles",
  team: "cc_teams",
  assignment: "cc_assignments",
  section: "cc_sections",
  memory: "cc_memory",
  income: "cc_income",
  cost: "cc_costs",
} as const satisfies Record<CommandCenterEntity, string>;

const ARCHIVABLE: ReadonlySet<CommandCenterEntity> = new Set(["agentProfile", "team", "cost"]);
const JSON_COLUMNS: ReadonlySet<string> = new Set([
  "model_selection",
  "missing",
  "project_ids",
  "depends_on",
]);
const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set(["done"]);

const SNAPSHOT_MEMORY_LIMIT = 100;
const SNAPSHOT_OPEN_TODO_LIMIT = 200;
const SNAPSHOT_FINISHED_ASSIGNMENT_LIMIT = 50;
const SNAPSHOT_INCOME_MONTHS = 13;
const LIST_MEMORY_DEFAULT_LIMIT = 50;
const RECALL_LIST_LIMIT = 10;
const RECALL_TODO_LIMIT = 30;
const RECALL_PROGRESS_LIMIT = 20;
// ponytail: recall clips each entry instead of offering a fetch-full-text tool; add one if
// agents ever need the long tail of a note.
const RECALL_TEXT_LIMIT = 600;
const FINISHED_ASSIGNMENT_RETENTION_DAYS = 90;
const DONE_TODO_RETENTION_DAYS = 180;
const DAILY_DIGEST_PREFIX = "Daily digest";

type Row = Record<string, unknown>;

const snakeCase = (key: string) => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const camelCase = (column: string) =>
  column.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());

/** Entity fields to SQLite columns. Columns match the camelCase fields in snake_case. */
function toRow(value: Row): Row {
  const row: Row = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    const column = snakeCase(key);
    row[column] = JSON_COLUMNS.has(column)
      ? JSON.stringify(field)
      : typeof field === "boolean"
        ? Number(field)
        : field;
  }
  return row;
}

/** SQLite row to undecoded entity fields; unknown columns are dropped by the decode. */
function fromRow(row: Row): Row {
  const value: Row = {};
  for (const [column, field] of Object.entries(row)) {
    value[camelCase(column)] =
      JSON_COLUMNS.has(column) && typeof field === "string"
        ? JSON.parse(field)
        : BOOLEAN_COLUMNS.has(column)
          ? field === 1
          : field;
  }
  return value;
}

const decodeRecord = Schema.decodeUnknownEffect(CommandCenterRecord);
const decodeSnapshot = Schema.decodeUnknownEffect(CommandCenterSnapshot);
const decodeRecall = Schema.decodeUnknownEffect(CommandCenterMemoryRecall);
const decodeMemoryPage = Schema.decodeUnknownEffect(CommandCenterListMemoryResult);
const decodeMemoryEntry = Schema.decodeUnknownEffect(CommandCenterMemoryEntry);
const decodeSection = Schema.decodeUnknownEffect(CommandCenterSection);
const decodeSections = Schema.decodeUnknownEffect(Schema.Array(CommandCenterSection));
const isCommandCenterError = Schema.is(CommandCenterError);

const failWith = (message: string) => (cause: unknown) =>
  new CommandCenterError({ message, cause });

/** Parses JSON columns and decodes; a corrupt row is a visible error, not a silent drop. */
const decodeRows = <A>(
  message: string,
  decode: (rows: unknown) => Effect.Effect<A, unknown>,
  build: () => unknown,
) =>
  Effect.try({ try: build, catch: failWith(message) }).pipe(
    Effect.flatMap(decode),
    Effect.mapError(failWith(message)),
  );

/** Compares section names so "DISEÑO" and "Diseño" are one section (SQLite's lower() is ASCII only). */
const sectionNameKey = (name: string) => name.normalize("NFC").toLocaleLowerCase();

const clipText = (row: Row): Row =>
  typeof row.text === "string" && row.text.length > RECALL_TEXT_LIMIT
    ? { ...row, text: `${row.text.slice(0, RECALL_TEXT_LIMIT - 1)}…` }
    : row;

/** Entities a `summary` subscription leaves out. */
const SUMMARY_SKIPS: ReadonlySet<CommandCenterEntity> = new Set(["memory", "income", "cost"]);

/** First day of the month `months - 1` months before `now`'s, as `YYYY-MM-DD`. */
const monthsBackStart = (now: DateTime.DateTime, months: number) =>
  DateTime.formatIsoDateUtc(
    DateTime.subtract(DateTime.startOf(now, "month"), { months: months - 1 }),
  );

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureCommandCenterSchema.pipe(Effect.orDie);
  const crypto = yield* Crypto.Crypto;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const scheduler = yield* Scheduler.Scheduler;
  const digestContext = yield* Effect.context<
    ProcessRunner.ProcessRunner | FileSystem.FileSystem | Path.Path
  >();
  // Unbounded: subscribers apply every change in order, so dropping one would desync them.
  const changes = yield* PubSub.unbounded<CommandCenterStreamEvent>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const newId = crypto.randomUUIDv4.pipe(
    Effect.mapError(failWith("Could not generate a Command Center id.")),
  );
  const isEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.commandCenter.enabled),
    Effect.mapError(failWith("Could not read the Command Center setting.")),
  );

  const isHome = sql<{ readonly home: number }>`
    SELECT (
      EXISTS (SELECT 1 FROM cc_meta WHERE key = 'home')
      OR EXISTS (SELECT 1 FROM cc_teams)
      OR EXISTS (SELECT 1 FROM cc_agent_profiles)
    ) AS home
  `.pipe(
    Effect.map(([row]) => row?.home === 1),
    Effect.mapError(failWith("Could not read the Command Center.")),
  );
  const markHome = Effect.gen(function* () {
    const now = yield* nowIso;
    yield* sql`
      INSERT INTO cc_meta (key, value) VALUES ('home', ${now}) ON CONFLICT (key) DO NOTHING
    `.pipe(Effect.mapError(failWith("Could not read the Command Center.")));
  });

  const checkAgentAccess = Effect.fn("CommandCenterService.checkAgentAccess")(function* () {
    if (!(yield* isEnabled)) {
      return yield* new CommandCenterError({
        message:
          "Command Center is turned off on this machine, so its memory and sections are unavailable.",
      });
    }
    if (!(yield* isHome)) {
      return yield* new CommandCenterError({
        message:
          "Command Center is not set up on this machine; the user keeps its memory and sections on another one. Put what you would save in your final reply instead.",
      });
    }
  });

  const readSnapshot = Effect.fn("CommandCenterService.getSnapshot")(function* (
    scope: CommandCenterSubscribeInput["scope"],
  ) {
    const now = yield* DateTime.now;
    const incomeSince = monthsBackStart(now, SNAPSHOT_INCOME_MONTHS);
    const none = Effect.succeed<ReadonlyArray<Row>>([]);
    const summary = scope === "summary";
    const query = Effect.all({
      agentProfiles: sql<Row>`SELECT * FROM cc_agent_profiles ORDER BY sort_key, created_at, rowid`,
      teams: sql<Row>`SELECT * FROM cc_teams ORDER BY sort_key, created_at, rowid`,
      assignments: sql<Row>`
        SELECT * FROM cc_assignments
        WHERE finished_at IS NULL OR id IN (
          SELECT id FROM cc_assignments WHERE finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT ${SNAPSHOT_FINISHED_ASSIGNMENT_LIMIT}
        )
        ORDER BY created_at DESC, rowid DESC
      `,
      sections: sql<Row>`SELECT * FROM cc_sections ORDER BY project_id, sort_key, created_at, rowid`,
      memory: summary
        ? none
        : sql<Row>`
            SELECT * FROM cc_memory
            WHERE id IN (
              SELECT id FROM cc_memory WHERE kind = 'todo' AND done = 0
              ORDER BY created_at DESC LIMIT ${SNAPSHOT_OPEN_TODO_LIMIT}
            ) OR id IN (
              SELECT id FROM cc_memory ORDER BY created_at DESC, rowid DESC
              LIMIT ${SNAPSHOT_MEMORY_LIMIT}
            )
            ORDER BY created_at DESC, rowid DESC
          `,
      income: summary
        ? none
        : sql<Row>`
            SELECT * FROM cc_income WHERE date >= ${incomeSince}
            ORDER BY date DESC, created_at DESC, rowid DESC
          `,
      costs: summary ? none : sql<Row>`SELECT * FROM cc_costs ORDER BY created_at, rowid`,
    });
    const rows = yield* query.pipe(Effect.mapError(failWith("Could not read the Command Center.")));
    return yield* decodeRows("Could not read the Command Center.", decodeSnapshot, () =>
      Object.fromEntries(
        Object.entries(rows).map(([key, entityRows]) => [key, entityRows.map(fromRow)]),
      ),
    );
  });

  const subscribe = (input: CommandCenterSubscribeInput = {}) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!(yield* isEnabled)) {
          return yield* new CommandCenterError({
            message: "Command Center is turned off on this server (commandCenter.enabled).",
          });
        }
        // Summary views (mobile) also watch remote machines, so only a full view marks home.
        if (input.scope === undefined) yield* markHome;
        // Subscribe before reading the snapshot so a change landing between the two is
        // delivered after it rather than lost. Re-applying an upsert or delete is harmless.
        const subscription = yield* PubSub.subscribe(changes);
        const changesStream = Stream.fromSubscription(subscription);
        return Stream.concat(
          Stream.fromEffect(
            readSnapshot(input.scope).pipe(
              Effect.map((snapshot): CommandCenterStreamEvent => ({ type: "snapshot", snapshot })),
            ),
          ),
          input.scope === "summary"
            ? changesStream.pipe(
                Stream.filter(
                  (event) =>
                    !SUMMARY_SKIPS.has(
                      event.type === "deleted"
                        ? event.entity
                        : event.type === "upserted"
                          ? event.record.entity
                          : "team",
                    ),
                ),
              )
            : changesStream,
        );
      }),
    );

  const publishRecord = (entity: CommandCenterEntity, row: Row) =>
    decodeRows("Could not read the saved Command Center row.", decodeRecord, () => ({
      entity,
      value: fromRow(row),
    })).pipe(Effect.tap((record) => PubSub.publish(changes, { type: "upserted", record })));

  const readMemory = (row: Row) =>
    decodeRows("Could not read the memory entry.", decodeMemoryEntry, () => fromRow(row));
  const readSection = (row: Row) =>
    decodeRows("Could not read the section.", decodeSection, () => fromRow(row));
  const publishMemory = (row: Row) =>
    readMemory(row).pipe(
      Effect.tap((value) =>
        PubSub.publish(changes, { type: "upserted", record: { entity: "memory", value } }),
      ),
    );
  const publishSection = (row: Row) =>
    readSection(row).pipe(
      Effect.tap((value) =>
        PubSub.publish(changes, { type: "upserted", record: { entity: "section", value } }),
      ),
    );

  /** Inserts (no `id`) or replaces a row; the server owns ids and timestamps. */
  const saveRow = Effect.fn("CommandCenterService.saveRow")(function* (
    entity: CommandCenterEntity,
    value: Row,
  ) {
    const now = yield* nowIso;
    const id = value.id ?? (yield* newId);
    const row: Row = {
      ...toRow({ ...value, id }),
      created_at: now,
      ...(entity === "assignment" ? {} : { updated_at: now }),
      ...(ARCHIVABLE.has(entity) ? { archived_at: null } : {}),
    };
    const message = `Could not save the ${entity}.`;
    const [saved] = yield* sql<Row>`
      INSERT INTO ${sql(TABLES[entity])} ${sql.insert(row)}
      ON CONFLICT (id) DO UPDATE SET ${sql.update(row, ["id", "created_at"])}
      RETURNING *
    `.pipe(Effect.mapError(failWith(message)));
    if (saved === undefined) return yield* new CommandCenterError({ message });
    return saved;
  });

  const publishDeleted = (entity: CommandCenterEntity, ids: ReadonlyArray<{ id: string }>) =>
    Effect.forEach(ids, ({ id }) => PubSub.publish(changes, { type: "deleted", entity, id }), {
      discard: true,
    });

  /** Finishes the agent's open assignments other than `keep`; returns the finished rows. */
  const finishOpenAssignments = (agentId: string, keep: string | null) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return yield* sql<Row>`
        UPDATE cc_assignments SET finished_at = ${now}
        WHERE agent_id = ${agentId} AND finished_at IS NULL AND id IS NOT ${keep}
        RETURNING *
      `.pipe(Effect.mapError(failWith("Could not finish the agent's assignments.")));
    });

  const upsert = Effect.fn("CommandCenterService.upsert")(function* (
    input: CommandCenterUpsertInput,
  ) {
    if (input.entity !== "assignment" || input.value.finishedAt !== null) {
      return yield* publishRecord(input.entity, yield* saveRow(input.entity, input.value));
    }
    const agentId = input.value.agentId;
    const { saved, finished } = yield* Effect.gen(function* () {
      const saved = yield* saveRow("assignment", input.value);
      return { saved, finished: yield* finishOpenAssignments(agentId, String(saved.id)) };
    }).pipe(
      sql.withTransaction,
      Effect.mapError((error) =>
        isCommandCenterError(error) ? error : failWith("Could not save the assignment.")(error),
      ),
    );
    // Published after commit so subscribers never see a row that rolled back.
    for (const row of finished) yield* publishRecord("assignment", row);
    return yield* publishRecord("assignment", saved);
  });

  const deleteRow = Effect.fn("CommandCenterService.delete")(function* (
    input: CommandCenterDeleteInput,
  ) {
    const table = TABLES[input.entity];
    const message = `Could not delete the ${input.entity}.`;
    if (ARCHIVABLE.has(input.entity)) {
      const now = yield* nowIso;
      const archived = yield* sql<Row>`
        UPDATE ${sql(table)} SET archived_at = ${now}, updated_at = ${now}
        WHERE id = ${input.id} AND archived_at IS NULL
        RETURNING *
      `.pipe(Effect.mapError(failWith(message)));
      for (const row of archived) yield* publishRecord(input.entity, row);
      // An archived agent leaves its work; otherwise nothing could ever release it.
      if (input.entity === "agentProfile" && archived.length > 0) {
        for (const row of yield* finishOpenAssignments(input.id, null)) {
          yield* publishRecord("assignment", row);
        }
      }
      return;
    }
    const removed = yield* sql<{ id: string }>`
      DELETE FROM ${sql(table)} WHERE id = ${input.id} RETURNING id
    `.pipe(Effect.mapError(failWith(message)));
    yield* publishDeleted(input.entity, removed);
  });

  const setMemoryDone = Effect.fn("CommandCenterService.setMemoryDone")(function* (
    input: CommandCenterSetMemoryDoneInput,
  ) {
    const now = yield* nowIso;
    const [row] = yield* sql<Row>`
      UPDATE cc_memory SET done = ${input.done ? 1 : 0}, updated_at = ${now}
      WHERE id = ${input.id}
      RETURNING *
    `.pipe(Effect.mapError(failWith("Could not update the memory entry.")));
    if (row === undefined) {
      return yield* new CommandCenterError({ message: "Memory entry not found." });
    }
    return yield* publishMemory(row);
  });

  const recallMemory = Effect.fn("CommandCenterService.recallMemory")(function* (
    input: CommandCenterMemoryRecallInput,
  ) {
    const projectId = input.projectId ?? null;
    const inScope = projectId === null ? sql`1 = 1` : sql`project_id = ${projectId}`;
    const query = Effect.all({
      // The daily digest (source 'system') never replaces what an agent last wrote: the
      // newest agent entry per project leads, then each project's newest digest.
      progress: sql<Row>`
        SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY project_id, source = 'system' ORDER BY created_at DESC, rowid DESC
          ) AS position, rowid AS insertion
          FROM cc_memory WHERE kind = 'progress' AND ${inScope}
        )
        WHERE position = 1
        ORDER BY source = 'system', created_at DESC, insertion DESC
        LIMIT ${RECALL_PROGRESS_LIMIT}
      `,
      openTodos: sql<Row>`
        SELECT * FROM cc_memory WHERE kind = 'todo' AND done = 0 AND ${inScope}
        ORDER BY created_at, rowid LIMIT ${RECALL_TODO_LIMIT}
      `,
      decisions: sql<Row>`
        SELECT * FROM cc_memory WHERE kind = 'decision' AND ${inScope}
        ORDER BY created_at DESC, rowid DESC LIMIT ${RECALL_LIST_LIMIT}
      `,
      handoffs: sql<Row>`
        SELECT * FROM cc_memory WHERE kind = 'handoff' AND ${inScope}
        ORDER BY created_at DESC, rowid DESC LIMIT ${RECALL_LIST_LIMIT}
      `,
    });
    const rows = yield* query.pipe(Effect.mapError(failWith("Could not recall memory.")));
    return yield* decodeRows("Could not recall memory.", decodeRecall, () =>
      Object.fromEntries(
        Object.entries(rows).map(([key, entityRows]) => [
          key,
          entityRows.map((row) => clipText(fromRow(row))),
        ]),
      ),
    );
  });

  const listMemory = Effect.fn("CommandCenterService.listMemory")(function* (
    input: CommandCenterListMemoryInput,
  ) {
    const limit = input.limit ?? LIST_MEMORY_DEFAULT_LIMIT;
    // One extra row tells whether another page exists.
    const rows = yield* sql<Row>`
      SELECT * FROM cc_memory
      WHERE ${sql.and([
        ...(input.projectId === undefined ? [] : [sql`project_id = ${input.projectId}`]),
        ...(input.kind === undefined ? [] : [sql`kind = ${input.kind}`]),
        ...(input.before === undefined
          ? []
          : [
              // A value cursor, so paging survives the `before` entry being deleted meanwhile.
              sql`(created_at, id) < (
                COALESCE(
                  ${input.beforeCreatedAt ?? null},
                  (SELECT created_at FROM cc_memory WHERE id = ${input.before})
                ),
                ${input.before}
              )`,
            ]),
      ])}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit + 1}
    `.pipe(Effect.mapError(failWith("Could not list memory.")));
    return yield* decodeRows("Could not list memory.", decodeMemoryPage, () => ({
      entries: rows.slice(0, limit).map(fromRow),
      hasMore: rows.length > limit,
    }));
  });

  const listSections = Effect.fn("CommandCenterService.listSections")(function* (
    projectId: ProjectId | null,
  ) {
    const rows = yield* sql<Row>`
      SELECT * FROM cc_sections
      WHERE ${projectId === null ? sql`1 = 1` : sql`project_id = ${projectId}`}
      ORDER BY project_id, sort_key, created_at, rowid
    `.pipe(Effect.mapError(failWith("Could not read the sections.")));
    const sections = yield* decodeRows("Could not read the sections.", decodeSections, () =>
      rows.map(fromRow),
    );
    return { sections };
  });

  const createSection = Effect.fn("CommandCenterService.createSection")(function* (
    value: Omit<SectionValue, "id">,
  ) {
    // The transaction holds the connection, so two creates of one name cannot both insert.
    const key = sectionNameKey(value.name);
    const { row, created } = yield* Effect.gen(function* () {
      const rows = yield* sql<Row>`
        SELECT * FROM cc_sections WHERE project_id = ${value.projectId}
      `.pipe(Effect.mapError(failWith("Could not read the sections.")));
      const existing = rows.find(
        (candidate) => typeof candidate.name === "string" && sectionNameKey(candidate.name) === key,
      );
      if (existing !== undefined) return { row: existing, created: false };
      return { row: yield* saveRow("section", value), created: true };
    }).pipe(
      sql.withTransaction,
      Effect.mapError((error) =>
        isCommandCenterError(error) ? error : failWith("Could not save the section.")(error),
      ),
    );
    // Published after commit so subscribers never see a row that rolled back.
    return yield* created ? publishSection(row) : readSection(row);
  });

  const patchSection = Effect.fn("CommandCenterService.patchSection")(function* (
    id: CommandCenterSectionId,
    patch: CommandCenterSectionPatch,
  ) {
    const now = yield* nowIso;
    const [row] = yield* sql<Row>`
      UPDATE cc_sections SET ${sql.update({ ...toRow(patch), updated_at: now })}
      WHERE id = ${id}
      RETURNING *
    `.pipe(Effect.mapError(failWith("Could not update the section.")));
    if (row === undefined) {
      return yield* new CommandCenterError({ message: "Section not found." });
    }
    return yield* publishSection(row);
  });

  const findRepoDigest = (projectId: ProjectId) =>
    sql<Row>`
      SELECT * FROM cc_memory
      WHERE project_id = ${projectId} AND kind = 'note' AND source = 'system'
        AND text LIKE ${`${REPO_DIGEST_PREFIX}%`}
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `.pipe(
      Effect.mapError(failWith("Could not read the repo digest.")),
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.succeedNone : readMemory(row).pipe(Effect.asSome),
      ),
    );

  // ponytail: one lock for every project's digest; per-project locks if scans ever queue up.
  // Serializing find-then-save keeps one digest per project when builds overlap.
  const digestLock = yield* Semaphore.make(1);

  const buildDigestUnlocked = Effect.fn("CommandCenterService.buildRepoDigest")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(failWith("Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* new CommandCenterError({ message: "Project not found." });
    }
    const text = yield* collectRepoDigest(project.value.workspaceRoot).pipe(
      Effect.provide(digestContext),
    );
    // Rebuilding replaces the previous digest so memory keeps one per project.
    const previous = yield* findRepoDigest(projectId);
    return yield* publishMemory(
      yield* saveRow("memory", {
        id: Option.isSome(previous) ? previous.value.id : undefined,
        projectId,
        sectionId: null,
        threadId: null,
        kind: "note",
        text,
        done: false,
        source: "system",
      }),
    );
  });

  const buildRepoDigest = (projectId: ProjectId) =>
    digestLock.withPermits(1)(buildDigestUnlocked(projectId));

  // Checked inside the lock, so a second caller reuses the digest the first one just built.
  const getRepoDigest = (projectId: ProjectId) =>
    digestLock.withPermits(1)(
      findRepoDigest(projectId).pipe(
        Effect.flatMap((cached) =>
          Option.isSome(cached) ? Effect.succeed(cached.value) : buildDigestUnlocked(projectId),
        ),
      ),
    );

  const ensureOnboardingTeam = Effect.fn("CommandCenterService.ensureOnboardingTeam")(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failWith("Could not read the server settings.")),
    );
    const preset = onboardingPreset({
      leadModel: settings.defaultModelSelection ?? settings.textGenerationModelSelection,
      cheapModel: settings.textGenerationModelSelection,
      runtimeMode: settings.defaultRuntimeMode,
    });
    const now = yield* nowIso;
    // Insert when missing; otherwise only un-archive, so edited prompts and models survive.
    const ensure = (entity: "team" | "agentProfile", value: Row) => {
      const row = { ...toRow(value), created_at: now, updated_at: now, archived_at: null };
      return sql<Row>`
          INSERT INTO ${sql(TABLES[entity])} ${sql.insert(row)}
          ON CONFLICT (id) DO UPDATE SET
            archived_at = NULL,
            updated_at = CASE WHEN archived_at IS NULL THEN updated_at ELSE ${now} END
          RETURNING *
        `.pipe(
        Effect.mapError(failWith("Could not create the Onboarding team.")),
        Effect.flatMap(([saved]) =>
          saved === undefined
            ? Effect.fail(
                new CommandCenterError({ message: "Could not create the Onboarding team." }),
              )
            : publishRecord(entity, saved),
        ),
      );
    };
    const records = yield* Effect.forEach(
      [ensure("team", preset.team), ...preset.agents.map((agent) => ensure("agentProfile", agent))],
      (effect) => effect,
    );
    const team = records.flatMap((record) => (record.entity === "team" ? [record.value] : []));
    const agents = records.flatMap((record) =>
      record.entity === "agentProfile" ? [record.value] : [],
    );
    if (team[0] === undefined) {
      return yield* new CommandCenterError({ message: "Could not create the Onboarding team." });
    }
    return { team: team[0], agents };
  });

  const runDailyMaintenance = Effect.fn("CommandCenterService.runDailyMaintenance")(function* () {
    if (!(yield* isEnabled)) return false;
    const now = yield* DateTime.now;
    const daysAgo = (days: number) => DateTime.formatIso(DateTime.subtract(now, { days }));
    const message = "Could not run the Command Center daily tick.";

    const prunedAssignments = yield* sql<{ id: string }>`
      DELETE FROM cc_assignments
      WHERE finished_at IS NOT NULL AND finished_at < ${daysAgo(FINISHED_ASSIGNMENT_RETENTION_DAYS)}
      RETURNING id
    `.pipe(Effect.mapError(failWith(message)));
    yield* publishDeleted("assignment", prunedAssignments);
    const prunedTodos = yield* sql<{ id: string }>`
      DELETE FROM cc_memory
      WHERE kind = 'todo' AND done = 1 AND updated_at < ${daysAgo(DONE_TODO_RETENTION_DAYS)}
      RETURNING id
    `.pipe(Effect.mapError(failWith(message)));
    yield* publishDeleted("memory", prunedTodos);

    // Yesterday in UTC: a finished day, so the digest never changes after it is written.
    const today = DateTime.startOf(now, "day");
    const yesterday = DateTime.subtract(today, { days: 1 });
    const end = DateTime.formatIso(today);
    const start = DateTime.formatIso(yesterday);
    const day = DateTime.formatIsoDateUtc(yesterday);
    const prefix = `${DAILY_DIGEST_PREFIX} ${day}`;
    type Count = { readonly project_id: string; readonly n: number };
    const counts = yield* Effect.all({
      finished: sql<Count>`
        SELECT project_id, COUNT(*) AS n FROM cc_assignments
        WHERE finished_at >= ${start} AND finished_at < ${end} GROUP BY project_id
      `,
      sections: sql<Count>`
        SELECT project_id, COUNT(*) AS n FROM cc_sections
        WHERE updated_at >= ${start} AND updated_at < ${end} GROUP BY project_id
      `,
      opened: sql<Count>`
        SELECT project_id, COUNT(*) AS n FROM cc_memory
        WHERE kind = 'todo' AND project_id IS NOT NULL
          AND created_at >= ${start} AND created_at < ${end} GROUP BY project_id
      `,
      closed: sql<Count>`
        SELECT project_id, COUNT(*) AS n FROM cc_memory
        WHERE kind = 'todo' AND done = 1 AND project_id IS NOT NULL
          AND updated_at >= ${start} AND updated_at < ${end} GROUP BY project_id
      `,
      written: sql<{ readonly project_id: string }>`
        SELECT project_id FROM cc_memory
        WHERE kind = 'progress' AND source = 'system' AND text LIKE ${`${prefix}%`}
      `,
    }).pipe(Effect.mapError(failWith(message)));

    const byProject = new Map<
      string,
      Record<"finished" | "sections" | "opened" | "closed", number>
    >();
    for (const key of ["finished", "sections", "opened", "closed"] as const) {
      for (const { project_id, n } of counts[key]) {
        const entry = byProject.get(project_id) ?? {
          finished: 0,
          sections: 0,
          opened: 0,
          closed: 0,
        };
        entry[key] = n;
        byProject.set(project_id, entry);
      }
    }
    const written = new Set(counts.written.map((row) => row.project_id));
    for (const [projectId, n] of byProject) {
      if (written.has(projectId)) continue;
      yield* publishMemory(
        yield* saveRow("memory", {
          projectId,
          sectionId: null,
          threadId: null,
          kind: "progress",
          text: `${prefix}: ${n.finished} assignments finished, ${n.sections} sections changed, ${n.opened} todos opened, ${n.closed} todos closed.`,
          done: false,
          source: "system",
        }),
      );
    }
    return true;
  });

  // One cheap check per scheduler tick; the real work runs once per UTC day. A day skipped
  // while disabled is not recorded, so turning Command Center back on runs it that same day.
  const lastRunDay = yield* Ref.make<string | null>(null);
  yield* scheduler.register(
    "command-center",
    Effect.gen(function* () {
      const today = (yield* nowIso).slice(0, 10);
      if ((yield* Ref.get(lastRunDay)) === today) return;
      if (yield* runDailyMaintenance()) yield* Ref.set(lastRunDay, today);
    }),
  );

  return CommandCenterService.of({
    getSnapshot: () => readSnapshot(undefined),
    subscribe,
    checkAgentAccess,
    upsert,
    delete: deleteRow,
    setMemoryDone,
    recallMemory,
    listMemory,
    listSections,
    createSection,
    patchSection,
    buildRepoDigest,
    getRepoDigest,
    ensureOnboardingTeam,
    runDailyMaintenance,
  });
});

export const layer = Layer.effect(CommandCenterService, make);
