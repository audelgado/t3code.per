// CC_HOME/cc.sqlite plus the token files. T3 bearer tokens never enter the DB:
// they live in CC_HOME/tokens/<machineId> (0600), so a DB backup carries no credentials.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Machine, ProjectRow, Task, TaskStatus } from "./types.ts";

const POSIX = process.platform !== "win32";
const chmod = (path: string, mode: number) => {
  if (POSIX && existsSync(path)) chmodSync(path, mode);
};

/** Opens (creating if needed) CC_HOME/cc.sqlite. Every statement is idempotent, so reopening is safe. */
export function openDb(home: string): DatabaseSync {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmod(home, 0o700);
  const file = join(home, "cc.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    pragma journal_mode = wal;
    pragma busy_timeout = 5000;
    pragma synchronous = normal;
    create table if not exists machines(
      id text primary key,
      label text not null,
      api_url text not null,
      web_url text,
      max_concurrent integer not null default 2,
      enabled integer not null default 1,
      server_version text,
      token_expires_at text,
      created_at text not null
    );
    create table if not exists projects(
      machine_id text not null,
      project_id text not null,
      title text not null,
      workspace_root text not null,
      default_model text,
      updated_at text not null,
      primary key (machine_id, project_id)
    );
    create table if not exists tasks(
      id text primary key,
      title text not null,
      prompt text not null,
      machine_id text not null,
      project_id text not null,
      model text,
      runtime_mode text,
      interaction_mode text not null,
      workspace text not null,
      priority integer not null default 0,
      depends_on text not null default '[]',
      source text not null,
      status text not null,
      command_id text,
      thread_id text,
      thread_seen_at text,
      limit_reset_at text,
      error text,
      result text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      finished_at text
    );
    create index if not exists tasks_queue on tasks(status, priority, created_at);
    create table if not exists kv(k text primary key, v text not null);
    create table if not exists pairings(h text primary key, exp integer not null);
    create table if not exists sessions(h text primary key, created integer not null, label text);
  `);
  // SQLite gives -wal/-shm the db file's mode; chmod existing ones anyway.
  for (const f of [file, `${file}-wal`, `${file}-shm`]) chmod(f, 0o600);
  return db;
}

// ---- row mapping: camelCase fields <-> snake_case columns ----

type Row = Record<string, unknown>;
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toParams(obj: object, json: ReadonlySet<string>, bool: ReadonlySet<string>) {
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[snake(k)] = json.has(k) ? (v === null ? null : JSON.stringify(v)) : bool.has(k) ? (v ? 1 : 0) : (v as SQLInputValue);
  }
  return out;
}
function fromRow<T>(row: Row, json: ReadonlySet<string>, bool: ReadonlySet<string>): T {
  const out: Row = {};
  for (const [col, v] of Object.entries(row)) {
    const k = camel(col);
    out[k] = json.has(k) ? (v === null ? null : JSON.parse(v as string)) : bool.has(k) ? v === 1 : v;
  }
  return out as T;
}
function insert(db: DatabaseSync, table: string, params: Record<string, SQLInputValue>, upsertKeys?: string[]) {
  const cols = Object.keys(params);
  const conflict = upsertKeys
    ? ` on conflict(${upsertKeys.join(", ")}) do update set ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`
    : "";
  db.prepare(`insert into ${table}(${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})${conflict}`).run(params);
}
function update(db: DatabaseSync, table: string, where: Record<string, SQLInputValue>, params: Record<string, SQLInputValue>) {
  const cols = Object.keys(params);
  if (cols.length === 0) return;
  const w = Object.keys(where);
  db.prepare(`update ${table} set ${cols.map((c) => `${c} = :${c}`).join(", ")} where ${w.map((c) => `${c} = :w_${c}`).join(" and ")}`).run({
    ...params,
    ...Object.fromEntries(w.map((c) => [`w_${c}`, where[c]!])),
  });
}

const NONE = new Set<string>();

// ---- tasks ----

const TASK_JSON = new Set(["model", "workspace", "dependsOn"]);

export function insertTask(db: DatabaseSync, task: Task) {
  insert(db, "tasks", toParams(task, TASK_JSON, NONE));
}
export function getTask(db: DatabaseSync, id: string): Task | undefined {
  const row = db.prepare("select * from tasks where id = ?").get(id);
  return row && fromRow<Task>(row, TASK_JSON, NONE);
}
/** All tasks, or only those in `statuses`; oldest first. */
export function listTasks(db: DatabaseSync, statuses?: TaskStatus[]): Task[] {
  const rows = statuses
    ? db.prepare(`select * from tasks where status in (${statuses.map(() => "?").join(", ")}) order by created_at`).all(...statuses)
    : db.prepare("select * from tasks order by created_at").all();
  return rows.map((r) => fromRow<Task>(r, TASK_JSON, NONE));
}
/** Applies `patch` (updatedAt is set for you) and returns the updated task. */
export function updateTask(db: DatabaseSync, id: string, patch: Partial<Omit<Task, "id">>): Task {
  update(db, "tasks", { id }, toParams({ ...patch, updatedAt: new Date().toISOString() }, TASK_JSON, NONE));
  const task = getTask(db, id);
  if (!task) throw new Error(`task ${id} not found`);
  return task;
}

// ---- machines ----

const MACHINE_BOOL = new Set(["enabled"]);

export function upsertMachine(db: DatabaseSync, machine: Machine) {
  insert(db, "machines", toParams(machine, NONE, MACHINE_BOOL), ["id"]);
}
export function getMachine(db: DatabaseSync, id: string): Machine | undefined {
  const row = db.prepare("select * from machines where id = ?").get(id);
  return row && fromRow<Machine>(row, NONE, MACHINE_BOOL);
}
export function listMachines(db: DatabaseSync): Machine[] {
  return db.prepare("select * from machines order by created_at").all().map((r) => fromRow<Machine>(r, NONE, MACHINE_BOOL));
}
export function updateMachine(db: DatabaseSync, id: string, patch: Partial<Omit<Machine, "id">>) {
  update(db, "machines", { id }, toParams(patch, NONE, MACHINE_BOOL));
}
/** Removes the machine, its project cache and its token file. Tasks are kept as history. */
export function deleteMachine(db: DatabaseSync, home: string, id: string) {
  db.prepare("delete from machines where id = ?").run(id);
  db.prepare("delete from projects where machine_id = ?").run(id);
  deleteToken(home, id);
}

// ---- project cache (so tasks can target projects of offline machines) ----

const PROJECT_JSON = new Set(["defaultModel"]);
const projectParams = ({ id, ...rest }: ProjectRow) => toParams({ ...rest, projectId: id }, PROJECT_JSON, NONE);
const toProject = (row: Row) => {
  const { projectId, ...rest } = fromRow<Omit<ProjectRow, "id"> & { projectId: string }>(row, PROJECT_JSON, NONE);
  return { ...rest, id: projectId };
};

/** Replaces the cached projects of one machine (call with an authoritative snapshot's rows). */
export function replaceProjects(db: DatabaseSync, machineId: string, rows: ProjectRow[]) {
  db.exec("begin");
  try {
    db.prepare("delete from projects where machine_id = ?").run(machineId);
    for (const row of rows) insert(db, "projects", projectParams({ ...row, machineId }));
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}
export function listProjects(db: DatabaseSync, machineId?: string): ProjectRow[] {
  const rows = machineId
    ? db.prepare("select * from projects where machine_id = ? order by title").all(machineId)
    : db.prepare("select * from projects order by machine_id, title").all();
  return rows.map(toProject);
}
export function getProject(db: DatabaseSync, machineId: string, projectId: string): ProjectRow | undefined {
  const row = db.prepare("select * from projects where machine_id = ? and project_id = ?").get(machineId, projectId);
  return row && toProject(row);
}

// ---- kv ----

export function kvGet<T>(db: DatabaseSync, key: string): T | undefined {
  const row = db.prepare("select v from kv where k = ?").get(key);
  return row && (JSON.parse(row.v as string) as T);
}
export function kvSet(db: DatabaseSync, key: string, value: unknown) {
  db.prepare("insert into kv(k, v) values (?, ?) on conflict(k) do update set v = excluded.v").run(key, JSON.stringify(value));
}

// ---- token files ----

/** machineId is a T3 environmentId; reject anything that could escape CC_HOME/tokens. */
function tokenPath(home: string, machineId: string) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(machineId)) throw new Error("invalid machine id");
  return join(home, "tokens", machineId);
}
export function readToken(home: string, machineId: string): string | null {
  const path = tokenPath(home, machineId);
  return existsSync(path) ? readFileSync(path, "utf8").trim() : null;
}
export function writeToken(home: string, machineId: string, token: string) {
  const path = tokenPath(home, machineId);
  const dir = join(home, "tokens");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmod(dir, 0o700);
  writeFileSync(`${path}.tmp`, token.trim(), { mode: 0o600 });
  chmod(`${path}.tmp`, 0o600);
  renameSync(`${path}.tmp`, path);
}
export function deleteToken(home: string, machineId: string) {
  rmSync(tokenPath(home, machineId), { force: true });
}
