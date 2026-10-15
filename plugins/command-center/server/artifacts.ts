// Artifacts: HTML and Markdown pages shared by the user and their agents, with every version kept.
// Rows live in cc_artifacts / cc_artifact_versions; each version's page is a file in CC_HOME/artifacts.
// Agents reach it through the artifact_* MCP tools (register `artifactTools`); the PWA through `artifactRoutes`.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { HttpError, MAX_BODY, type Route } from "./http.ts";
import { ToolError, type ToolDef } from "./mcp.ts";

export type ArtifactKind = "html" | "markdown";

export interface Artifact {
  id: string;
  projectId: string | null;
  title: string;
  kind: ArtifactKind;
  currentVersion: number;
  sourceThreadId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Archived artifacts leave the default list; archiving again with false brings them back. */
  archivedAt: string | null;
}

export interface ArtifactVersion {
  version: number;
  /** "user", or the agent label for MCP saves. */
  author: string;
  threadId: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface ArtifactDetail {
  artifact: Artifact;
  version: ArtifactVersion;
  content: string;
  /** Newest first. */
  versions: ArtifactVersion[];
}

export interface ArtifactSaveInput {
  /** Omit to create; give it to append a version. */
  id?: string;
  /** Required to create; renames when given with an id. */
  title?: string;
  /** Detected from the content when omitted; cannot change after creation. */
  kind?: ArtifactKind;
  content: string;
  projectId?: string | null;
  threadId?: string | null;
}

export interface ArtifactListInput {
  /** undefined = every project; null = artifacts without a project. */
  projectId?: string | null;
  /** Case-insensitive substring of the title. */
  query?: string;
  archived?: boolean;
  /** Cursor: only artifacts updated before this one. */
  before?: string;
  beforeUpdatedAt?: string;
  limit?: number;
}

export interface ArtifactPage {
  artifacts: Artifact[];
  hasMore: boolean;
}

export interface DiffLine {
  op: " " | "+" | "-";
  text: string;
}

// ponytail: augments the HTTP contract from here so types.ts stays untouched; move into Api when convenient.
declare module "./types.ts" {
  interface Api {
    "POST /api/artifacts/list": { body: ArtifactListInput; res: ArtifactPage };
    "GET /api/artifacts/:id": { body: never; res: ArtifactDetail };
    "GET /api/artifacts/:id/diff": { body: never; res: { from: number; to: number; lines: DiffLine[] } };
    "POST /api/artifacts": { body: ArtifactSaveInput; res: ArtifactDetail };
    "POST /api/artifacts/:id/restore": { body: { version: number }; res: ArtifactDetail };
    "POST /api/artifacts/:id/archive": { body: { archived: boolean }; res: Artifact };
  }
}

/** UTF-8 bytes per version. Pages arrive inside a JSON body capped at MAX_BODY, so this is the real ceiling. */
export const ARTIFACT_MAX_BYTES = MAX_BODY;
const MAX_TITLE = 200;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
// Ids and file names we generate; anything else never reaches a path.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT = { html: "html", markdown: "md" } as const;
const HTML_START = /^\s*(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body|svg|div|main|section|style|script|meta|link|title)\b/i;

export interface ArtifactStore {
  db: DatabaseSync;
  /** CC_HOME/artifacts. */
  dir: string;
}

export function openArtifacts(db: DatabaseSync, home: string): ArtifactStore {
  db.exec(`
    create table if not exists cc_artifacts(
      id text primary key,
      project_id text,
      title text not null,
      kind text not null,
      current_version integer not null,
      source_thread_id text,
      created_at text not null,
      updated_at text not null,
      archived_at text
    );
    create index if not exists cc_artifacts_updated on cc_artifacts(updated_at, id);
    create table if not exists cc_artifact_versions(
      artifact_id text not null,
      version integer not null,
      author text not null,
      thread_id text,
      file text not null,
      size_bytes integer not null,
      created_at text not null,
      primary key (artifact_id, version)
    );
  `);
  const dir = join(home, "artifacts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { db, dir };
}

type Row = Record<string, unknown>;
const toArtifact = (r: Row): Artifact => ({
  id: r.id as string,
  projectId: r.project_id as string | null,
  title: r.title as string,
  kind: r.kind as ArtifactKind,
  currentVersion: r.current_version as number,
  sourceThreadId: r.source_thread_id as string | null,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  archivedAt: r.archived_at as string | null,
});
const toVersion = (r: Row): ArtifactVersion => ({
  version: r.version as number,
  author: r.author as string,
  threadId: r.thread_id as string | null,
  sizeBytes: r.size_bytes as number,
  createdAt: r.created_at as string,
});

const notFound = () => new ToolError("Artifact not found");
const obj = (raw: unknown) => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {});
const optString = (a: Record<string, unknown>, key: string, max: number) => {
  const v = a[key];
  if (v === undefined || v === null) return v;
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new ToolError(`${key} must be a non-empty string of at most ${max} characters`);
  return v.trim();
};

function find(db: DatabaseSync, id: string): Artifact {
  const row = ID.test(id) ? db.prepare("select * from cc_artifacts where id = ?").get(id) : undefined;
  if (!row) throw notFound();
  return toArtifact(row);
}

function readVersion(store: ArtifactStore, id: string, version: number): { version: ArtifactVersion; content: string } {
  const row = store.db.prepare("select * from cc_artifact_versions where artifact_id = ? and version = ?").get(id, version);
  if (!row) throw new ToolError("Artifact version not found");
  const file = row.file as string;
  if (!/^[0-9a-f-]{36}-v\d+\.(html|md)$/.test(file)) throw new Error("bad artifact file name");
  return { version: toVersion(row), content: readFileSync(join(store.dir, file), "utf8") };
}

/** Validates untrusted input, then creates the artifact or appends a version (which also un-archives it). */
export function saveArtifact(store: ArtifactStore, raw: unknown, author: string): ArtifactDetail {
  const a = obj(raw);
  if (typeof a.content !== "string" || !a.content.trim()) throw new ToolError("content must be a non-empty string");
  const content = a.content;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > ARTIFACT_MAX_BYTES) throw new ToolError(`The page is ${Math.ceil(bytes / 1024)} KB; an artifact version holds at most ${ARTIFACT_MAX_BYTES / 1024} KB`);
  if (a.kind !== undefined && a.kind !== "html" && a.kind !== "markdown") throw new ToolError("kind must be html or markdown");
  const title = optString(a, "title", MAX_TITLE);
  const projectId = optString(a, "projectId", 200);
  const threadId = optString(a, "threadId", 200) ?? null;
  const id = a.id === undefined ? undefined : typeof a.id === "string" ? a.id : "";

  const { db } = store;
  const existing = id === undefined ? undefined : find(db, id);
  if (existing && a.kind !== undefined && a.kind !== existing.kind) throw new ToolError(`This artifact is ${existing.kind}; its kind cannot change`);
  if (!existing && !title) throw new ToolError("A new artifact needs a title");
  const kind: ArtifactKind = existing?.kind ?? (a.kind as ArtifactKind | undefined) ?? (HTML_START.test(content) ? "html" : "markdown");
  const artifactId = existing?.id ?? randomUUID();
  const version = (existing?.currentVersion ?? 0) + 1;
  const file = `${artifactId}-v${version}.${EXT[kind]}`;
  const now = new Date().toISOString();

  // The file first, then its rows in one transaction; only committed rows point at a file.
  writeFileSync(join(store.dir, file), content, { mode: 0o600 });
  db.exec("begin");
  try {
    if (existing) {
      db.prepare(
        `update cc_artifacts set current_version = ?, title = coalesce(?, title),
           project_id = case when ? then ? else project_id end, updated_at = ?, archived_at = null
         where id = ?`,
      ).run(version, title ?? null, projectId === undefined ? 0 : 1, projectId ?? null, now, artifactId);
    } else {
      db.prepare(
        "insert into cc_artifacts(id, project_id, title, kind, current_version, source_thread_id, created_at, updated_at) values (?, ?, ?, ?, 1, ?, ?, ?)",
      ).run(artifactId, projectId ?? null, title!, kind, threadId, now, now);
    }
    db.prepare("insert into cc_artifact_versions(artifact_id, version, author, thread_id, file, size_bytes, created_at) values (?, ?, ?, ?, ?, ?, ?)").run(
      artifactId,
      version,
      author,
      threadId,
      file,
      bytes,
      now,
    );
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    rmSync(join(store.dir, file), { force: true });
    throw e;
  }
  return getArtifact(store, artifactId);
}

/** A version (the current one by default) with its content and the full history. */
export function getArtifact(store: ArtifactStore, id: string, version?: number): ArtifactDetail {
  const artifact = find(store.db, id);
  const shown = readVersion(store, id, version ?? artifact.currentVersion);
  const versions = store.db.prepare("select * from cc_artifact_versions where artifact_id = ? order by version desc").all(id).map(toVersion);
  return { artifact, ...shown, versions };
}

/** Appends a copy of an older version as the new current one; history is never rewritten. */
export function restoreArtifactVersion(store: ArtifactStore, id: string, version: number, author: string): ArtifactDetail {
  const { content } = readVersion(store, find(store.db, id).id, version);
  return saveArtifact(store, { id, content }, author);
}

export function setArtifactArchived(db: DatabaseSync, id: string, archived: boolean): Artifact {
  find(db, id);
  const now = new Date().toISOString();
  const row = db
    .prepare(`update cc_artifacts set archived_at = ${archived ? "coalesce(archived_at, ?)" : "null"}, updated_at = ? where id = ? returning *`)
    .get(...(archived ? [now] : []), now, id);
  return toArtifact(row!);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Most recently updated first, keyset-paged on (updated_at, id) so paging survives the cursor row changing. */
export function listArtifacts(db: DatabaseSync, input: ArtifactListInput = {}): ArtifactPage {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const where = [input.archived ? "archived_at is not null" : "archived_at is null"];
  const args: string[] = [];
  if (input.projectId === null) where.push("project_id is null");
  else if (input.projectId !== undefined) (where.push("project_id = ?"), args.push(input.projectId));
  const needle = input.query?.trim();
  if (needle) (where.push("title like ? escape '\\'"), args.push(`%${escapeLike(needle)}%`));
  if (input.before !== undefined) {
    const at = input.beforeUpdatedAt ?? (db.prepare("select updated_at from cc_artifacts where id = ?").get(input.before)?.updated_at as string | undefined);
    if (at !== undefined) (where.push("(updated_at, id) < (?, ?)"), args.push(at, input.before));
  }
  // One extra row tells whether another page exists.
  const rows = db.prepare(`select * from cc_artifacts where ${where.join(" and ")} order by updated_at desc, id desc limit ?`).all(...args, limit + 1);
  return { artifacts: rows.slice(0, limit).map(toArtifact), hasMore: rows.length > limit };
}

/** Line diff of `before` → `after` (LCS over the lines between the common prefix and suffix). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const same = (lines: string[]) => lines.map((text): DiffLine => ({ op: " ", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const mid: DiffLine[] = [];
  // ponytail: O(n·m) table; past 4M cells the middle shows as one replace block. Myers diff if that bites.
  if (n * m > 4_000_000) {
    mid.push(...midA.map((text): DiffLine => ({ op: "-", text })), ...midB.map((text): DiffLine => ({ op: "+", text })));
  } else {
    // lcs[i*(m+1)+j] = LCS length of midA[i..] and midB[j..].
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * (m + 1) + j] = midA[i] === midB[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) mid.push({ op: " ", text: midA[i++]! }), j++;
      else if (j < m && (i === n || lcs[i * (m + 1) + j + 1]! >= lcs[(i + 1) * (m + 1) + j]!)) mid.push({ op: "+", text: midB[j++]! });
      else mid.push({ op: "-", text: midA[i++]! });
    }
  }
  return [...same(a.slice(0, start)), ...mid, ...same(a.slice(endA))];
}

const versionArg = (v: unknown, name: string) => {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < 1) throw new ToolError(`${name} must be a positive integer`);
  return v as number;
};
const idArg = (v: unknown) => {
  if (typeof v !== "string" || !v) throw new ToolError("id must be a non-empty string");
  return v;
};

// ---- MCP tools ----

export function artifactTools(store: ArtifactStore): ToolDef[] {
  return [
    {
      name: "artifact_save",
      description: `Save an HTML or Markdown page to the user's Command Center artifacts library, where they can view it on their phone. Omit id to create one (title required); pass the id of an existing artifact to save a new version of it (every version is kept). Use it for reports, plans, mockups and other deliverables the user should read, or when asked to. At most ${ARTIFACT_MAX_BYTES / 1024} KB per version.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing artifact to version. Omit to create." },
          title: { type: "string", maxLength: MAX_TITLE, description: "Required when creating; renames otherwise." },
          kind: { type: "string", enum: ["html", "markdown"], description: "Detected from the content when omitted." },
          content: { type: "string", description: "The full page. HTML is shown in a sandboxed frame (scripts run, no network credentials)." },
          projectId: { type: "string", description: "Project it belongs to (see machines_list). Omit for none." },
          threadId: { type: "string", description: "Your T3 thread id, when known." },
        },
        required: ["content"],
      },
      handler: (args, agent) => brief(saveArtifact(store, args, agent)),
    },
    {
      name: "artifact_list",
      description: "List artifacts in the user's library, most recently updated first (ids, titles, kinds, versions). Page with before = the last id.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring of the title." },
          projectId: { type: "string", description: "Only this project." },
          before: { type: "string" },
          limit: { type: "number", maximum: MAX_LIMIT },
        },
      },
      handler: (args) =>
        listArtifacts(store.db, {
          query: typeof args.query === "string" ? args.query : undefined,
          projectId: typeof args.projectId === "string" && args.projectId ? args.projectId : undefined,
          before: typeof args.before === "string" ? args.before : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
    },
    {
      name: "artifact_get",
      description: "Read one artifact: its content (the current version, or `version`) and its version history.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, version: { type: "number" } },
        required: ["id"],
      },
      handler: (args) => getArtifact(store, idArg(args.id), versionArg(args.version, "version")),
    },
  ];
}

/** What a save returns to an agent: no echo of the content it just sent. */
const brief = ({ artifact, version }: ArtifactDetail) => ({ id: artifact.id, title: artifact.title, kind: artifact.kind, version: version.version });

// ---- HTTP routes (cookie auth, user author) ----

const http = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    const missing = e.message.endsWith("not found");
    throw new HttpError(missing ? 404 : 400, missing ? "not_found" : "bad_request", e.message);
  }
};
const queryVersion = (url: URL, key: string) => {
  const v = url.searchParams.get(key);
  return v === null ? undefined : versionArg(Number(v), key);
};

export function artifactRoutes(store: ArtifactStore): Route[] {
  return [
    {
      method: "POST",
      path: "/api/artifacts/list",
      auth: "cookie",
      handler: ({ body }) =>
        http(() => {
          const b = obj(body);
          const str = (k: string) => {
            if (b[k] === undefined) return undefined;
            if (typeof b[k] !== "string") throw new ToolError(`${k} must be a string`);
            return b[k] as string;
          };
          if (b.archived !== undefined && typeof b.archived !== "boolean") throw new ToolError("archived must be a boolean");
          if (b.limit !== undefined && typeof b.limit !== "number") throw new ToolError("limit must be a number");
          return listArtifacts(store.db, {
            projectId: b.projectId === null ? null : str("projectId"),
            query: str("query"),
            archived: b.archived as boolean | undefined,
            before: str("before"),
            beforeUpdatedAt: str("beforeUpdatedAt"),
            limit: b.limit as number | undefined,
          });
        }),
    },
    {
      method: "GET",
      path: "/api/artifacts/:id",
      auth: "cookie",
      handler: ({ params, url }) => http(() => getArtifact(store, params.id!, queryVersion(url, "version"))),
    },
    {
      method: "GET",
      path: "/api/artifacts/:id/diff",
      auth: "cookie",
      handler: ({ params, url }) =>
        http(() => {
          const { id, currentVersion } = find(store.db, params.id!);
          const to = queryVersion(url, "to") ?? currentVersion;
          const from = queryVersion(url, "from") ?? to - 1;
          if (from < 1) throw new ToolError("There is no earlier version to compare");
          const before = readVersion(store, id, from).content;
          const after = readVersion(store, id, to).content;
          return { from, to, lines: lineDiff(before, after) };
        }),
    },
    { method: "POST", path: "/api/artifacts", auth: "cookie", handler: ({ body }) => http(() => saveArtifact(store, body, "user")) },
    {
      method: "POST",
      path: "/api/artifacts/:id/restore",
      auth: "cookie",
      handler: ({ params, body }) => http(() => restoreArtifactVersion(store, params.id!, versionArg(obj(body).version ?? null, "version")!, "user")),
    },
    {
      method: "POST",
      path: "/api/artifacts/:id/archive",
      auth: "cookie",
      handler: ({ params, body }) =>
        http(() => {
          const archived = obj(body).archived;
          if (typeof archived !== "boolean") throw new ToolError("archived must be a boolean");
          return setArtifactArchived(store.db, params.id!, archived);
        }),
    },
  ];
}
