// Agent profiles: a named role (avatar, role prompt, default model and modes) applied to a task.
// Applying one only prefixes the prompt and fills defaults; it never creates a standing agent.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TaskError, type Dispatcher } from "./dispatcher.ts";
import { HttpError, type Route } from "./http.ts";
import { ToolError, type ToolDef } from "./mcp.ts";
import { createPlan, PlanError, type PlanInput } from "./plan.ts";
import type { InteractionMode, ModelSelection, Ok, RuntimeMode, Task, TaskInput, TaskSource } from "./types.ts";

export interface Profile {
  id: string;
  name: string;
  /** Usually one emoji; may be empty. */
  avatar: string;
  rolePrompt: string;
  model: ModelSelection | null;
  /** Default for user tasks only; an approver always picks it for agent tasks. */
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode | null;
  /** "user" or "agent:<label>". */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileInput {
  name: string;
  avatar?: string;
  rolePrompt?: string;
  model?: ModelSelection | null;
  runtimeMode?: RuntimeMode | null;
  interactionMode?: InteractionMode | null;
}

// ponytail: augments the HTTP contract from here so types.ts stays untouched; move into it when convenient.
declare module "./types.ts" {
  interface TaskInput {
    /** Applied server-side by applyProfile. */
    profileId?: string;
  }
  interface Api {
    "GET /api/profiles": { body: never; res: Profile[] };
    "POST /api/profiles": { body: ProfileInput; res: Profile };
    "PATCH /api/profiles/:id": { body: ProfileInput; res: Profile };
    "DELETE /api/profiles/:id": { body: never; res: Ok };
    "POST /api/plans": { body: PlanInput; res: Task[] };
  }
}

const RUNTIME_MODES = new Set<string>(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const NAME_MAX = 40;
const PROMPT_MAX = 4000;

export function initProfiles(db: DatabaseSync) {
  db.exec(`create table if not exists cc_agent_profiles(
    id text primary key,
    name text not null unique collate nocase,
    avatar text not null default '',
    role_prompt text not null default '',
    model text,
    runtime_mode text,
    interaction_mode text,
    created_by text not null,
    created_at text not null,
    updated_at text not null
  )`);
}

const toProfile = (r: Record<string, unknown>): Profile => ({
  id: r.id as string,
  name: r.name as string,
  avatar: r.avatar as string,
  rolePrompt: r.role_prompt as string,
  model: r.model ? (JSON.parse(r.model as string) as ModelSelection) : null,
  runtimeMode: r.runtime_mode as RuntimeMode | null,
  interactionMode: r.interaction_mode as InteractionMode | null,
  createdBy: r.created_by as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

export function listProfiles(db: DatabaseSync): Profile[] {
  return db.prepare("select * from cc_agent_profiles order by name").all().map(toProfile);
}
export function getProfile(db: DatabaseSync, id: string): Profile | undefined {
  const row = db.prepare("select * from cc_agent_profiles where id = ?").get(id);
  return row && toProfile(row);
}
export function deleteProfile(db: DatabaseSync, id: string): boolean {
  return db.prepare("delete from cc_agent_profiles where id = ? returning 1").get(id) !== undefined;
}

/** Validates `input` and inserts (no id) or replaces (id) a profile. Agents cannot set runtime or interaction mode. */
export function saveProfile(db: DatabaseSync, input: unknown, by: "user" | `agent:${string}`, id?: string): Profile {
  const bad = (m: string) => new TaskError("invalid", m);
  if (typeof input !== "object" || input === null) throw bad("profile must be an object");
  const i = input as Record<string, unknown>;
  const name = typeof i.name === "string" ? i.name.trim() : "";
  if (!name || name.length > NAME_MAX) throw bad(`name must be 1-${NAME_MAX} characters`);
  const avatar = i.avatar ?? "";
  if (typeof avatar !== "string" || avatar.length > 8) throw bad("avatar must be at most 8 characters");
  const rolePrompt = i.rolePrompt ?? "";
  if (typeof rolePrompt !== "string" || rolePrompt.length > PROMPT_MAX) throw bad(`rolePrompt must be at most ${PROMPT_MAX} characters`);
  const m = i.model ?? null;
  if (m !== null && (typeof m !== "object" || typeof (m as ModelSelection).instanceId !== "string" || typeof (m as ModelSelection).model !== "string"))
    throw bad("model must be {instanceId, model}");
  const runtimeMode = by === "user" ? (i.runtimeMode ?? null) : null;
  if (runtimeMode !== null && !RUNTIME_MODES.has(runtimeMode as string)) throw bad("invalid runtimeMode");
  const interactionMode = by === "user" ? (i.interactionMode ?? null) : null;
  if (interactionMode !== null && interactionMode !== "default" && interactionMode !== "plan") throw bad("invalid interactionMode");

  const row = {
    name,
    avatar,
    role_prompt: rolePrompt,
    model: m ? JSON.stringify({ instanceId: (m as ModelSelection).instanceId, model: (m as ModelSelection).model }) : null,
    runtime_mode: runtimeMode as string | null,
    interaction_mode: interactionMode as string | null,
    updated_at: new Date().toISOString(),
  };
  try {
    if (id !== undefined) {
      const hit = db
        .prepare(
          "update cc_agent_profiles set name=:name, avatar=:avatar, role_prompt=:role_prompt, model=:model, runtime_mode=:runtime_mode, interaction_mode=:interaction_mode, updated_at=:updated_at where id=:id returning 1",
        )
        .get({ ...row, id });
      if (!hit) throw new TaskError("not_found", "profile not found");
    } else {
      id = randomUUID();
      db.prepare(
        "insert into cc_agent_profiles(id, name, avatar, role_prompt, model, runtime_mode, interaction_mode, created_by, created_at, updated_at) values (:id, :name, :avatar, :role_prompt, :model, :runtime_mode, :interaction_mode, :created_by, :updated_at, :updated_at)",
      ).run({ ...row, id, created_by: by });
    }
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw new TaskError("conflict", "a profile with that name exists");
    throw e;
  }
  return getProfile(db, id)!;
}

export interface ResolvedProfile {
  /** Role prompt plus a blank line, or "" when the role is empty. */
  promptPrefix: string;
  model: ModelSelection | null;
  /** Always null for agent-sourced tasks. */
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode | null;
}

export function resolveProfile(db: DatabaseSync, profileId: string, agentSourced: boolean): ResolvedProfile {
  const p = getProfile(db, profileId);
  if (!p) throw new TaskError("invalid", "unknown profile");
  return {
    promptPrefix: p.rolePrompt.trim() ? `${p.rolePrompt.trim()}\n\n` : "",
    model: p.model,
    runtimeMode: agentSourced ? null : p.runtimeMode,
    interactionMode: p.interactionMode,
  };
}

/**
 * Returns `input` with its profile applied: prompt prefix, and the profile's model, runtime mode and
 * interaction mode wherever the input leaves them unset. The title stays that of the bare prompt.
 * Call it before Dispatcher.createTask; inputs without profileId pass through untouched.
 */
export function applyProfile(db: DatabaseSync, input: TaskInput, source: TaskSource): TaskInput {
  const { profileId, ...rest } = input;
  if (profileId === undefined || profileId === null) return rest;
  if (typeof profileId !== "string") throw new TaskError("invalid", "unknown profile");
  const p = resolveProfile(db, profileId, source !== "user");
  const bare = typeof rest.prompt === "string" ? rest.prompt.trim() : "";
  return {
    ...rest,
    prompt: p.promptPrefix + bare,
    title: rest.title ?? (bare.split("\n")[0] || undefined),
    model: rest.model ?? p.model,
    runtimeMode: rest.runtimeMode ?? p.runtimeMode ?? undefined,
    interactionMode: rest.interactionMode ?? p.interactionMode ?? undefined,
  };
}

// ---- HTTP and MCP ----

const statusOf = { invalid: [400, "bad_request"], not_found: [404, "not_found"], conflict: [409, "conflict"] } as const;

/** Service errors become HttpError for the route table. */
function toHttp(e: unknown): unknown {
  if (e instanceof TaskError) return new HttpError(statusOf[e.code][0], statusOf[e.code][1], e.message);
  if (e instanceof PlanError) return new HttpError(400, "bad_request", e.message);
  return e;
}

/** Profile CRUD plus POST /api/plans (kept here because plans apply profiles). */
export function createProfileRoutes(deps: { db: DatabaseSync; tasks: Pick<Dispatcher, "createTask" | "cancel"> }): Route[] {
  const { db, tasks } = deps;
  return [
    { method: "GET", path: "/api/profiles", auth: "cookie", handler: () => listProfiles(db) },
    {
      method: "POST",
      path: "/api/profiles",
      auth: "cookie",
      handler: ({ body }) => {
        try {
          return saveProfile(db, body, "user");
        } catch (e) {
          throw toHttp(e);
        }
      },
    },
    {
      method: "PATCH",
      path: "/api/profiles/:id",
      auth: "cookie",
      handler: ({ body, params }) => {
        try {
          return saveProfile(db, body, "user", params.id!);
        } catch (e) {
          throw toHttp(e);
        }
      },
    },
    {
      method: "DELETE",
      path: "/api/profiles/:id",
      auth: "cookie",
      handler: ({ params }) => {
        if (!deleteProfile(db, params.id!)) throw new HttpError(404, "not_found", "profile not found");
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/plans",
      auth: "cookie",
      handler: async ({ body }) => {
        const input = (typeof body === "object" && body !== null ? body : {}) as PlanInput;
        try {
          return await createPlan(tasks, input, "user", (t) => applyProfile(db, { ...t, profileId: input.profileId }, "user"));
        } catch (e) {
          throw toHttp(e);
        }
      },
    },
  ];
}

/** MCP tool for agents. Register it with createMcp(...).registerTools. */
export function profileTools(db: DatabaseSync): ToolDef[] {
  return [
    {
      name: "agent_profile_save",
      description:
        "Create or update one of your own reusable role profiles (name, role prompt, optional avatar and model). The user can then pick it when asking for work. It cannot set permissions, and you can only change profiles you created.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of one of your profiles to edit; omit to create (or update by name)" },
          name: { type: "string", description: `1-${NAME_MAX} characters; saving an existing name of yours updates it` },
          rolePrompt: { type: "string", description: `Instructions prefixed to the task prompt, at most ${PROMPT_MAX} characters` },
          avatar: { type: "string", description: "One emoji" },
          modelSelection: { type: "object", properties: { instanceId: { type: "string" }, model: { type: "string" } }, required: ["instanceId", "model"] },
        },
        required: ["name", "rolePrompt"],
      },
      handler: (args, agent) => {
        const by = `agent:${agent}` as const;
        const name = typeof args.name === "string" ? args.name.trim() : "";
        // role_prompt/model are accepted as aliases of the fork's rolePrompt/modelSelection.
        const rolePrompt = args.rolePrompt ?? args.role_prompt;
        if (typeof rolePrompt !== "string" || !rolePrompt.trim()) throw new ToolError("rolePrompt is required");
        const all = listProfiles(db);
        const existing = args.id === undefined ? all.find((p) => p.name.toLowerCase() === name.toLowerCase()) : all.find((p) => p.id === args.id);
        if (args.id !== undefined && !existing) throw new ToolError("Unknown profile id");
        if (existing && existing.createdBy !== by) throw new ToolError("That profile is not yours");
        try {
          const p = saveProfile(db, { name, avatar: args.avatar, rolePrompt, model: args.modelSelection ?? args.model }, by, existing?.id);
          return { id: p.id, name: p.name, note: "Saved. The user picks it in Ask." };
        } catch (e) {
          if (e instanceof TaskError) throw new ToolError(e.message);
          throw e;
        }
      },
    },
  ];
}
