import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Creates the Command Center tables (docs/command-center/SPEC.md) when the service starts.
 *
 * Not a numbered migration on purpose: this fork tracks upstream, and the migrator skips every
 * id up to the highest one recorded, so a fork migration at any id would either take upstream's
 * next id or make upstream's later migrations never run. Every statement is idempotent.
 *
 * JSON columns hold arrays or model selections; money is integer cents. Memory keeps its rowid
 * so entries written in the same millisecond still order by insertion.
 */
export const ensureCommandCenterSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      avatar TEXT,
      role TEXT NOT NULL,
      role_prompt TEXT NOT NULL,
      model_selection TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      interaction_mode TEXT NOT NULL,
      team_id TEXT,
      sort_key INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      lead_agent_id TEXT,
      environment_id TEXT,
      sort_key INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_assignments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      section_id TEXT,
      task TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_sections (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      tasks_done INTEGER NOT NULL,
      tasks_total INTEGER NOT NULL,
      due_date TEXT,
      trying TEXT,
      blocker TEXT,
      missing TEXT NOT NULL,
      depends_on TEXT NOT NULL DEFAULT '[]',
      sort_key INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      section_id TEXT,
      thread_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_income (
      id TEXT PRIMARY KEY,
      concept TEXT NOT NULL,
      client_name TEXT NOT NULL,
      date TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Single flags; `home` marks the machine where a client opened Command Center.
  yield* sql`CREATE TABLE IF NOT EXISTS cc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_costs (
      id TEXT PRIMARY KEY,
      concept TEXT NOT NULL,
      category TEXT NOT NULL,
      monthly_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      project_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  // Databases created by the earlier numbered migrations (fork ids 62/63) predate these columns.
  const columns = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );
  if (!(yield* columns("cc_sections")).has("depends_on")) {
    yield* sql`ALTER TABLE cc_sections ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`;
  }
  if ((yield* columns("cc_income")).has("client")) {
    yield* sql`ALTER TABLE cc_income RENAME COLUMN client TO client_name`;
  }
  // Free the ids those migrations took, so upstream's own 62 and 63 run when they ship.
  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE (migration_id = 62 AND name = 'CommandCenter')
       OR (migration_id = 63 AND name = 'CommandCenterWave2')
  `.pipe(Effect.ignore);

  // Indexes for the queries the service runs: the snapshot's newest-memory window and open
  // todos, project-scoped memory, open/finished assignments, and sections per project.
  yield* sql`CREATE INDEX IF NOT EXISTS cc_memory_created ON cc_memory (created_at)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS cc_memory_open_todos ON cc_memory (created_at)
    WHERE kind = 'todo' AND done = 0
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_memory_project_kind ON cc_memory (project_id, kind)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_memory_project_created ON cc_memory (project_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_assignments_finished ON cc_assignments (finished_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_assignments_agent ON cc_assignments (agent_id, finished_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_sections_project ON cc_sections (project_id)`;
});
