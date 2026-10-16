// Sections: per-project workstreams (status, counts, blocker...) that people and agents keep current.
// The web imports selectSectionPage from here, so this file must keep to type-only imports;
// the runtime pieces of http.ts and mcp.ts arrive through createSections' `kit`. Do not import node modules at runtime.
import { paginateCollection } from "./collections.ts";
import type { DatabaseSync } from "node:sqlite";
import type { HttpError, Route } from "./http.ts";
import type { ToolDef, ToolError, resolveProject } from "./mcp.ts";

export const SECTION_STATUSES = ["todo", "in_progress", "review", "blocked", "done"] as const;
export type SectionStatus = (typeof SECTION_STATUSES)[number];

export interface Section {
  id: string;
  /** T3 project id (the same on every machine that has the project). */
  projectId: string;
  name: string;
  status: SectionStatus;
  tasksDone: number;
  tasksTotal: number;
  /** YYYY-MM-DD. */
  dueDate: string | null;
  trying: string | null;
  blocker: string | null;
  missing: string[];
  /** Ids of sections (any project) this one waits on. */
  dependsOn: string[];
  prUrl: string | null;
  sortKey: number;
  createdAt: string;
  updatedAt: string;
}

/** Editable fields; omitted ones keep their value, null clears dueDate, trying, blocker and prUrl. */
export type SectionFields = Pick<Section, "name" | "status" | "tasksDone" | "tasksTotal" | "dueDate" | "trying" | "blocker" | "missing" | "dependsOn" | "prUrl">;
export type SectionCreate = { projectId: string } & Partial<SectionFields> & Pick<SectionFields, "name">;

declare module "./types.ts" {
  interface Api {
    "GET /api/sections": { body: never; res: Section[] };
    "POST /api/sections": { body: SectionCreate; res: Section };
    "PATCH /api/sections/:id": { body: Partial<SectionFields>; res: Section };
    "DELETE /api/sections/:id": { body: never; res: { ok: true } };
  }
}

/** bad_request becomes HTTP 400, not_found 404; tools show the message to the agent. */
export class SectionError extends Error {
  readonly code: "bad_request" | "not_found";
  constructor(code: "bad_request" | "not_found", message: string) {
    super(message);
    this.code = code;
  }
}
const bad = (message: string) => new SectionError("bad_request", message);

// ---- validation ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nameKey = (name: string) => name.normalize("NFC").toLocaleLowerCase();

function short(v: unknown, key: string, max: number, nullable: boolean): string | null {
  if (v === null && nullable) return null;
  if (typeof v !== "string" || (!nullable && !v.trim())) throw bad(`${key} must be a ${nullable ? "string or null" : "non-empty string"}`);
  if (v.length > max) throw bad(`${key} must be at most ${max} characters`);
  return v.trim() || null;
}
function count(v: unknown, key: string) {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 1_000_000) throw bad(`${key} must be an integer from 0 to 1000000`);
  return v as number;
}
function strings(v: unknown, key: string, max: number, item: number) {
  if (!Array.isArray(v) || v.length > max) throw bad(`${key} must be an array of at most ${max} strings`);
  return v.map((x) => short(x, key, item, false)!);
}

/** Validates the fields present in `input`; unknown keys are ignored. */
export function parseFields(input: unknown): Partial<SectionFields> {
  if (!isObj(input)) throw bad("Body must be a JSON object");
  const out: Partial<SectionFields> = {};
  const has = (k: string) => input[k] !== undefined;
  if (has("name")) out.name = short(input.name, "name", 80, false)!;
  if (has("status")) {
    if (!SECTION_STATUSES.includes(input.status as SectionStatus)) throw bad(`status must be one of ${SECTION_STATUSES.join(", ")}`);
    out.status = input.status as SectionStatus;
  }
  if (has("tasksDone")) out.tasksDone = count(input.tasksDone, "tasksDone");
  if (has("tasksTotal")) out.tasksTotal = count(input.tasksTotal, "tasksTotal");
  if (has("dueDate")) {
    const d = short(input.dueDate, "dueDate", 10, true);
    if (d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))) throw bad("dueDate must be YYYY-MM-DD");
    out.dueDate = d;
  }
  if (has("trying")) out.trying = short(input.trying, "trying", 500, true);
  if (has("blocker")) out.blocker = short(input.blocker, "blocker", 500, true);
  if (has("missing")) out.missing = strings(input.missing, "missing", 20, 200);
  if (has("dependsOn")) out.dependsOn = [...new Set(strings(input.dependsOn, "dependsOn", 20, 100))];
  if (has("prUrl")) {
    const u = short(input.prUrl, "prUrl", 500, true);
    if (u !== null && !/^https:\/\/[^\s/]+\/\S+$/.test(u)) throw bad("prUrl must be an https URL");
    out.prUrl = u;
  }
  return out;
}

// ---- storage ----

const toSection = (r: Record<string, unknown>): Section => ({
  id: r.id as string,
  projectId: r.project_id as string,
  name: r.name as string,
  status: r.status as SectionStatus,
  tasksDone: r.tasks_done as number,
  tasksTotal: r.tasks_total as number,
  dueDate: r.due_date as string | null,
  trying: r.trying as string | null,
  blocker: r.blocker as string | null,
  missing: JSON.parse(r.missing as string) as string[],
  dependsOn: JSON.parse(r.depends_on as string) as string[],
  prUrl: r.pr_url as string | null,
  sortKey: r.sort_key as number,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

/** Camel-case fields to snake-case columns; arrays are stored as JSON. */
function columns(f: Partial<SectionFields>) {
  const out: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(f)) {
    out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = Array.isArray(v) ? JSON.stringify(v) : (v as string | number | null);
  }
  return out;
}

export function createSectionService(db: DatabaseSync) {
  db.exec(`
    create table if not exists cc_sections(
      id text primary key,
      project_id text not null,
      name text not null,
      status text not null default 'todo',
      tasks_done integer not null default 0,
      tasks_total integer not null default 0,
      due_date text,
      trying text,
      blocker text,
      missing text not null default '[]',
      depends_on text not null default '[]',
      pr_url text,
      sort_key integer not null default 0,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists cc_sections_project on cc_sections(project_id, sort_key, created_at);
  `);
  const get = (id: string) => {
    const row = db.prepare("select * from cc_sections where id = ?").get(id);
    return row && toSection(row);
  };
  /** One project's sections (or all) in display order. */
  const list = (projectId?: string): Section[] =>
    (projectId
      ? db.prepare("select * from cc_sections where project_id = ? order by sort_key, created_at, rowid").all(projectId)
      : db.prepare("select * from cc_sections order by project_id, sort_key, created_at, rowid").all()
    ).map(toSection);
  /** Dependencies must exist and not be the section itself. */
  const checkDeps = (id: string | null, deps: string[] | undefined) => {
    for (const d of deps ?? []) {
      if (d === id) throw bad("A section cannot depend on itself");
      if (!get(d)) throw bad(`Unknown section in dependsOn: ${d}`);
    }
  };

  return {
    get,
    list,
    /** Creates the section, or returns the project's existing one with the same name (any case). */
    create(input: unknown): Section {
      if (!isObj(input) || typeof input.projectId !== "string" || !input.projectId) throw bad("projectId is required");
      if (input.name === undefined) throw bad("name is required");
      const projectId = input.projectId;
      const f = parseFields(input);
      const same = list(projectId).find((s) => nameKey(s.name) === nameKey(f.name!));
      if (same) return same;
      checkDeps(null, f.dependsOn);
      const now = new Date().toISOString();
      const next = db.prepare("select coalesce(max(sort_key), -1) + 1 as n from cc_sections where project_id = ?").get(projectId)!.n as number;
      const id = crypto.randomUUID();
      const row = { id, project_id: projectId, sort_key: next, created_at: now, updated_at: now, ...columns(f) };
      const cols = Object.keys(row);
      db.prepare(`insert into cc_sections(${cols.join(", ")}) values (${cols.map((c) => `:${c}`).join(", ")})`).run(row);
      return get(id)!;
    },
    update(id: string, input: unknown): Section {
      const current = get(id);
      if (!current) throw new SectionError("not_found", "Section not found");
      const f = parseFields(input);
      if (f.name !== undefined && nameKey(f.name) !== nameKey(current.name) && list(current.projectId).some((s) => nameKey(s.name) === nameKey(f.name!)))
        throw bad("Another section in this project has that name");
      checkDeps(id, f.dependsOn);
      const cols = columns(f);
      const set = [...Object.keys(cols), "updated_at"].map((c) => `${c} = :${c}`);
      db.prepare(`update cc_sections set ${set.join(", ")} where id = :id`).run({ ...cols, updated_at: new Date().toISOString(), id });
      return get(id)!;
    },
    /** Deletes the section and drops it from other sections' dependsOn. */
    remove(id: string): void {
      if (!get(id)) throw new SectionError("not_found", "Section not found");
      db.prepare("delete from cc_sections where id = ?").run(id);
      db.prepare(
        `update cc_sections set depends_on = (select json_group_array(value) from json_each(depends_on) where value != ?1)
         where exists (select 1 from json_each(depends_on) where value = ?1)`,
      ).run(id);
    },
  };
}
export type SectionService = ReturnType<typeof createSectionService>;

// ---- HTTP + MCP ----

export interface SectionKit {
  HttpError: typeof HttpError;
  ToolError: typeof ToolError;
  resolveProject: typeof resolveProject;
}

/**
 * Wire-up: `routes.push(...s.routes)` and `mcp.registerTools(s.tools)`, with
 * `kit = { HttpError, ToolError, resolveProject }` and `machineLabel` mapping a machine id to its label.
 */
export function createSections(db: DatabaseSync, kit: SectionKit, machineLabel: (id: string) => string = (id) => id) {
  const service = createSectionService(db);
  const translate = <T>(fn: () => T, make: (e: SectionError) => Error): T => {
    try {
      return fn();
    } catch (e) {
      throw e instanceof SectionError ? make(e) : e;
    }
  };
  const http = <T>(fn: () => T) => translate(fn, (e) => new kit.HttpError(e.code === "not_found" ? 404 : 400, e.code, e.message));
  const tool = <T>(fn: () => T) => translate(fn, (e) => new kit.ToolError(e.message));

  const resolve = (query: unknown) => {
    if (typeof query !== "string" || !query.trim()) throw new kit.ToolError("project must be a project id, a path inside it, or its title");
    const rows = (db.prepare("select * from projects").all() as Record<string, string>[]).map((p) => ({
      machineId: p.machine_id!,
      id: p.project_id!,
      title: p.title!,
      workspaceRoot: p.workspace_root!,
      defaultModel: null,
      updatedAt: p.updated_at!,
    }));
    return kit.resolveProject(rows, query, machineLabel).id;
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/sections", auth: "cookie", handler: ({ url }) => service.list(url.searchParams.get("project") ?? undefined) },
    {
      method: "POST",
      path: "/api/sections",
      auth: "cookie",
      handler: ({ body }) => {
        const projectId = isObj(body) ? body.projectId : undefined;
        if (typeof projectId !== "string" || !db.prepare("select 1 from projects where project_id = ?").get(projectId))
          throw new kit.HttpError(400, "bad_request", "Unknown project");
        return http(() => service.create(body));
      },
    },
    { method: "PATCH", path: "/api/sections/:id", auth: "cookie", handler: ({ params, body }) => http(() => service.update(params.id!, body)) },
    // Cookie only: deleting is a user action and is deliberately not an MCP tool.
    {
      method: "DELETE",
      path: "/api/sections/:id",
      auth: "cookie",
      handler: ({ params }) => {
        http(() => service.remove(params.id!));
        return { ok: true };
      },
    },
  ];

  const fieldSchema = {
    status: { type: "string", enum: [...SECTION_STATUSES] },
    tasksDone: { type: "integer", minimum: 0 },
    tasksTotal: { type: "integer", minimum: 0 },
    dueDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
    trying: { type: ["string", "null"], description: "What is being tried now." },
    blocker: { type: ["string", "null"] },
    missing: { type: "array", items: { type: "string" }, description: "What is still missing." },
    dependsOn: { type: "array", items: { type: "string" }, description: "Ids (from section_list, any project) of sections this one waits on." },
  };

  const tools: ToolDef[] = [
    {
      name: "section_list",
      description:
        "List the sections (workstreams) of a project, with status, task counts, due date, what is being tried, blocker and what is missing. Use the returned id with section_update.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id, a path inside it, or its title. Omit for every project." },
          project: { type: "string", description: "Alias of projectId." },
        },
      },
      handler: (args) => {
        const q = args.projectId ?? args.project;
        return service.list(q === undefined ? undefined : resolve(q));
      },
    },
    {
      name: "section_create",
      description:
        "Create a section (a workstream such as Checkout or Auth) in a project. If the project already has a section with that name (any case) it is returned unchanged, so check section_list and use section_update to change existing ones.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id, a path inside it, or its title." },
          project: { type: "string", description: "Alias of projectId." },
          name: { type: "string" },
          ...fieldSchema,
        },
        required: ["projectId", "name"],
      },
      handler: ({ projectId: pid, project, ...rest }) => {
        const projectId = resolve(pid ?? project);
        return tool(() => service.create({ ...rest, projectId }));
      },
    },
    {
      name: "section_update",
      description: "Update a section (id from section_list) as work moves. Omitted fields keep their value; pass null to clear dueDate, trying, blocker or prUrl.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, ...fieldSchema, prUrl: { type: ["string", "null"], description: "https URL of the pull request that delivers it." } },
        required: ["id"],
      },
      handler: ({ id, ...rest }) => {
        if (typeof id !== "string") throw new kit.ToolError("id must be a section id from section_list");
        return tool(() => service.update(id, rest));
      },
    },
  ];

  return { routes, tools, service };
}

// ---- directory paging (used by the web) ----

export { paginateCollection } from "./collections.ts";

/** Filters one project's sections by status and search, keeping an open edit visible and on its page. */
export function selectSectionPage({
  sections,
  search,
  status,
  page,
  editing,
}: {
  sections: readonly Section[];
  search: string;
  status: SectionStatus | "all";
  page: number;
  editing: string | null;
}) {
  const needle = search.trim().toLocaleLowerCase();
  const matching = sections.filter(
    (s) =>
      (status === "all" || s.status === status) &&
      (!needle || [s.name, s.blocker, s.trying, ...s.missing].some((v) => v?.toLocaleLowerCase().includes(needle))),
  );
  const editingIndex = matching.findIndex((s) => s.id === editing);
  const directory = paginateCollection(matching, editingIndex >= 0 ? Math.floor(editingIndex / 10) + 1 : page, 10);
  const visible = [...directory.items];
  const edited = sections.find((s) => s.id === editing);
  if (edited && !visible.includes(edited)) visible.unshift(edited);
  return { ...directory, visible };
}
