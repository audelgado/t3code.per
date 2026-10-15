// Memory: short notes, todos, decisions and handoffs shared by the user and their agents (table cc_memory).
// Agents reach it through the memory_* MCP tools (register `memoryTools`); the PWA through `memoryRoutes`.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HttpError, type Route } from "./http.ts";
import { ToolError, type ToolDef } from "./mcp.ts";

export const MEMORY_KINDS = ["progress", "decision", "todo", "handoff", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemorySource = "user" | "agent" | "system";

export interface MemoryEntry {
  id: string;
  projectId: string | null;
  sectionId: string | null;
  threadId: string | null;
  kind: MemoryKind;
  text: string;
  /** Only meaningful for todos. */
  done: boolean;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecall {
  /** Latest progress entry per project, newest first. */
  progress: MemoryEntry[];
  /** Open todos, oldest first. */
  openTodos: MemoryEntry[];
  decisions: MemoryEntry[];
  handoffs: MemoryEntry[];
}

export interface MemorySaveInput {
  kind: MemoryKind;
  text: string;
  projectId?: string | null;
  sectionId?: string | null;
}

/** undefined = no filter; projectId null = entries without a project. */
export interface MemoryListInput {
  projectId?: string | null;
  kind?: MemoryKind;
  /** Case-insensitive substring of the text. */
  query?: string;
  done?: boolean;
  /** Cursor: only entries older than this one. */
  before?: string;
  beforeCreatedAt?: string;
  limit?: number;
}

export interface MemoryPage {
  entries: MemoryEntry[];
  /** Page on with the last entry as `before`. */
  hasMore: boolean;
}

// ponytail: augments the HTTP contract from here so types.ts stays untouched; move into Api when convenient.
declare module "./types.ts" {
  interface Api {
    "POST /api/memory/list": { body: MemoryListInput; res: MemoryPage };
    "POST /api/memory": { body: MemorySaveInput; res: MemoryEntry };
    "POST /api/memory/:id/done": { body: { done?: boolean }; res: MemoryEntry };
    "DELETE /api/memory/:id": { body: never; res: { ok: true } };
  }
}

const MAX_TEXT = 20_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const RECALL_PROGRESS = 20;
const RECALL_TODOS = 20;
const RECALL_LIST = 10;
/** Recall clips each entry; the full text is in the app. */
const RECALL_TEXT = 600;

export function initMemory(db: DatabaseSync) {
  db.exec(`
    create table if not exists cc_memory(
      id text primary key,
      project_id text,
      section_id text,
      thread_id text,
      kind text not null,
      text text not null,
      done integer not null,
      source text not null,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists cc_memory_created on cc_memory(created_at);
    create index if not exists cc_memory_project_kind on cc_memory(project_id, kind);
  `);
}

type Row = Record<string, unknown>;
const toEntry = (r: Row): MemoryEntry => ({
  id: r.id as string,
  projectId: r.project_id as string | null,
  sectionId: r.section_id as string | null,
  threadId: r.thread_id as string | null,
  kind: r.kind as MemoryKind,
  text: r.text as string,
  done: r.done === 1,
  source: r.source as MemorySource,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});
const clip = (e: MemoryEntry): MemoryEntry => (e.text.length > RECALL_TEXT ? { ...e, text: `${e.text.slice(0, RECALL_TEXT - 1)}…` } : e);

/** Validates untrusted input; throws ToolError (callers map it to their transport). */
export function parseSave(raw: unknown): { kind: MemoryKind; text: string; projectId: string | null; sectionId: string | null } {
  const a = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!MEMORY_KINDS.includes(a.kind as MemoryKind)) throw new ToolError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("text must be a non-empty string");
  if (a.text.trim().length > MAX_TEXT) throw new ToolError(`text must be at most ${MAX_TEXT} characters`);
  const id = (key: string) => {
    const v = a[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== "string" || !v || v.length > 200) throw new ToolError(`${key} must be a short string`);
    return v;
  };
  return { kind: a.kind as MemoryKind, text: a.text.trim(), projectId: id("projectId"), sectionId: id("sectionId") };
}

export function saveMemory(db: DatabaseSync, input: unknown, source: MemorySource): MemoryEntry {
  const v = parseSave(input);
  const now = new Date().toISOString();
  const entry: MemoryEntry = { id: randomUUID(), ...v, threadId: null, done: false, source, createdAt: now, updatedAt: now };
  db.prepare(
    "insert into cc_memory(id, project_id, section_id, thread_id, kind, text, done, source, created_at, updated_at) values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
  ).run(entry.id, entry.projectId, entry.sectionId, entry.threadId, entry.kind, entry.text, source, now, now);
  return entry;
}

export function setMemoryDone(db: DatabaseSync, id: string, done: boolean): MemoryEntry {
  const row = db.prepare("update cc_memory set done = ?, updated_at = ? where id = ? returning *").get(done ? 1 : 0, new Date().toISOString(), id);
  if (!row) throw new ToolError("Memory entry not found");
  return toEntry(row);
}

export function deleteMemory(db: DatabaseSync, id: string): boolean {
  return db.prepare("delete from cc_memory where id = ? returning 1").get(id) !== undefined;
}

/** Where recall is scoped: undefined/null = every project, otherwise one project. */
export function recallMemory(db: DatabaseSync, projectId?: string | null): MemoryRecall {
  const scope = projectId ? "project_id = ?" : "1 = 1";
  const args = projectId ? [projectId] : [];
  const q = (sql: string, limit: number) => db.prepare(sql).all(...args, limit).map(toEntry).map(clip);
  return {
    progress: q(
      `select * from (
         select *, row_number() over (partition by project_id order by created_at desc, rowid desc) as pos
         from cc_memory where kind = 'progress' and ${scope}
       ) where pos = 1 order by created_at desc limit ?`,
      RECALL_PROGRESS,
    ),
    openTodos: q(`select * from cc_memory where kind = 'todo' and done = 0 and ${scope} order by created_at, rowid limit ?`, RECALL_TODOS),
    decisions: q(`select * from cc_memory where kind = 'decision' and ${scope} order by created_at desc, rowid desc limit ?`, RECALL_LIST),
    handoffs: q(`select * from cc_memory where kind = 'handoff' and ${scope} order by created_at desc, rowid desc limit ?`, RECALL_LIST),
  };
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first, keyset-paged on (created_at, id) so paging survives the cursor entry being deleted. */
export function listMemory(db: DatabaseSync, input: MemoryListInput = {}): MemoryPage {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (input.projectId === null) where.push("project_id is null");
  else if (input.projectId !== undefined) (where.push("project_id = ?"), args.push(input.projectId));
  if (input.kind !== undefined) (where.push("kind = ?"), args.push(input.kind));
  if (input.done !== undefined) (where.push("done = ?"), args.push(input.done ? 1 : 0));
  const needle = input.query?.trim();
  if (needle) (where.push("text like ? escape '\\'"), args.push(`%${escapeLike(needle)}%`));
  if (input.before !== undefined) {
    const at =
      input.beforeCreatedAt ?? (db.prepare("select created_at from cc_memory where id = ?").get(input.before)?.created_at as string | undefined);
    if (at !== undefined) (where.push("(created_at, id) < (?, ?)"), args.push(at, input.before));
  }
  // One extra row tells whether another page exists.
  const rows = db
    .prepare(`select * from cc_memory ${where.length ? `where ${where.join(" and ")}` : ""} order by created_at desc, id desc limit ?`)
    .all(...args, limit + 1);
  return { entries: rows.slice(0, limit).map(toEntry), hasMore: rows.length > limit };
}

// ---- MCP tools (names and inputs as in the T3 fork) ----

const projectFilter = (v: unknown) => (typeof v === "string" && v ? v : null);

export function memoryTools(db: DatabaseSync): ToolDef[] {
  initMemory(db);
  return [
    {
      name: "memory_save",
      description:
        'Save an entry to the user\'s Command Center memory. Call it only when the user asks you to save, remember, note or keep something ("save this to memory", "remember that..."), or when your task instructions ask for it. Kinds: `progress` for where work was left, `todo` for something still open, `decision` for a choice and its reason, `handoff` for a note to the next team, `note` for anything else. Keep each entry short and self-contained.',
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...MEMORY_KINDS] },
          text: { type: "string", maxLength: MAX_TEXT },
          projectId: { type: "string", description: "Project it belongs to (see machines_list). Omit for none." },
          sectionId: { type: "string", description: "Section it belongs to." },
        },
        required: ["kind", "text"],
      },
      handler: (args) => saveMemory(db, args, "agent"),
    },
    {
      name: "memory_recall",
      description:
        "Recall where work was left off: the latest progress entry per project, open todos (with ids for memory_complete), and recent decisions and handoffs, each clipped to a short text. Call it when the user asks what is pending or where things stand, or when your task instructions ask for it.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string", description: "Only this project. Omit for every project." } },
      },
      handler: (args) => recallMemory(db, projectFilter(args.projectId)),
    },
    {
      name: "memory_complete",
      description: "Mark a memory todo as done (id from memory_recall). Call it when you finish something a todo describes. Pass done=false to reopen it.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, done: { type: "boolean", description: "Defaults to true." } },
        required: ["id"],
      },
      handler: (args) => {
        if (typeof args.id !== "string" || !args.id) throw new ToolError("id must be a non-empty string");
        if (args.done !== undefined && typeof args.done !== "boolean") throw new ToolError("done must be a boolean");
        return setMemoryDone(db, args.id, args.done ?? true);
      },
    },
  ];
}

// ---- HTTP routes (cookie auth, user source) ----

const obj = (b: unknown) => (typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {});
const bad = (e: unknown): never => {
  throw e instanceof ToolError ? new HttpError(e.message === "Memory entry not found" ? 404 : 400, e.message === "Memory entry not found" ? "not_found" : "bad_request", e.message) : e;
};

export function memoryRoutes(db: DatabaseSync): Route[] {
  initMemory(db);
  return [
    {
      method: "POST",
      path: "/api/memory/list",
      auth: "cookie",
      handler: ({ body }) => {
        const b = obj(body);
        const str = (k: string) => (b[k] === undefined ? undefined : typeof b[k] === "string" ? (b[k] as string) : bad(new ToolError(`${k} must be a string`)));
        const kind = str("kind");
        if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) bad(new ToolError("unknown kind"));
        if (b.done !== undefined && typeof b.done !== "boolean") bad(new ToolError("done must be a boolean"));
        if (b.limit !== undefined && typeof b.limit !== "number") bad(new ToolError("limit must be a number"));
        return listMemory(db, {
          projectId: b.projectId === null ? null : str("projectId"),
          kind: kind as MemoryKind | undefined,
          query: str("query"),
          done: b.done as boolean | undefined,
          before: str("before"),
          beforeCreatedAt: str("beforeCreatedAt"),
          limit: b.limit as number | undefined,
        });
      },
    },
    {
      method: "POST",
      path: "/api/memory",
      auth: "cookie",
      handler: ({ body }) => {
        try {
          return saveMemory(db, body, "user");
        } catch (e) {
          return bad(e);
        }
      },
    },
    {
      method: "POST",
      path: "/api/memory/:id/done",
      auth: "cookie",
      handler: ({ params, body }) => {
        const done = obj(body).done ?? true;
        if (typeof done !== "boolean") throw new HttpError(400, "bad_request", "done must be a boolean");
        try {
          return setMemoryDone(db, params.id!, done);
        } catch (e) {
          return bad(e);
        }
      },
    },
    {
      method: "DELETE",
      path: "/api/memory/:id",
      auth: "cookie",
      handler: ({ params }) => {
        if (!deleteMemory(db, params.id!)) throw new HttpError(404, "not_found", "Memory entry not found");
        return { ok: true };
      },
    },
  ];
}
