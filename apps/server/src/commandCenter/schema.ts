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

  // Wave 4. Artifact content lives in files under the attachments directory; these rows only
  // describe it. Versions are append-only; `current_version` is the newest.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_version INTEGER NOT NULL,
      source_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      author TEXT NOT NULL,
      author_label TEXT,
      thread_id TEXT,
      attachment_id TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_canvas_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT,
      text TEXT,
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      w INTEGER,
      h INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_canvas_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      from_item_id TEXT NOT NULL,
      to_item_id TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Wave 5. Workflows themselves are files in each project; these rows are their runs. A run
  // keeps the workflow it started with (JSON), so editing the file never changes a running graph.
  // `mode_limit` caps the modes of the threads a run started by an agent or a scheduled task may
  // use (JSON {runtimeMode, interactionMode}); null for the user's own runs. A step's `items` is
  // the full list a parallel node fans out over, parsed before its output was clipped.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_workflow_runs (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      status TEXT NOT NULL,
      inputs TEXT NOT NULL,
      workflow TEXT NOT NULL,
      error TEXT,
      mode_limit TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cc_workflow_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      item INTEGER,
      attempt INTEGER NOT NULL,
      thread_id TEXT,
      status TEXT NOT NULL,
      output TEXT,
      items TEXT,
      error TEXT,
      started_at TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  // Databases created by the earlier numbered migrations (fork ids 62/63) predate these columns,
  // and every database before wave 4 predates the pull request link.
  const columns = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );
  const sectionColumns = yield* columns("cc_sections");
  if (!sectionColumns.has("depends_on")) {
    yield* sql`ALTER TABLE cc_sections ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!sectionColumns.has("pr_url")) {
    yield* sql`ALTER TABLE cc_sections ADD COLUMN pr_url TEXT`;
  }
  if (!sectionColumns.has("pr_number")) {
    yield* sql`ALTER TABLE cc_sections ADD COLUMN pr_number INTEGER`;
  }
  // Databases from an early wave 5 build.
  if (!(yield* columns("cc_workflow_runs")).has("mode_limit")) {
    yield* sql`ALTER TABLE cc_workflow_runs ADD COLUMN mode_limit TEXT`;
  }
  if (!(yield* columns("cc_workflow_steps")).has("items")) {
    yield* sql`ALTER TABLE cc_workflow_steps ADD COLUMN items TEXT`;
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
  // Artifact pages (newest first, globally or per project) and one board per project.
  yield* sql`CREATE INDEX IF NOT EXISTS cc_artifacts_updated ON cc_artifacts (updated_at, id)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS cc_artifacts_project_updated ON cc_artifacts (project_id, updated_at, id)
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_canvas_items_project ON cc_canvas_items (project_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_canvas_edges_project ON cc_canvas_edges (project_id)`;
  // Run pages (newest first, globally or per project), a run's steps, and the daily prune.
  yield* sql`CREATE INDEX IF NOT EXISTS cc_workflow_runs_started ON cc_workflow_runs (started_at, id)`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS cc_workflow_runs_project ON cc_workflow_runs (project_id, started_at, id)
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_workflow_runs_finished ON cc_workflow_runs (finished_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS cc_workflow_steps_run ON cc_workflow_steps (run_id)`;
});
