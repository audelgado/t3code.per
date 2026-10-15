// The CC's own MCP server (Streamable HTTP, JSON responses only, no sessions) and its per-agent bearer tokens.
// Agents only submit work for human approval and only ever see their own tasks.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { sha256 } from "./auth.ts";
import { getTask, listMachines, listProjects } from "./db.ts";
import { TaskError, type Dispatcher } from "./dispatcher.ts";
import { HttpError, type Route } from "./http.ts";
import { T3Error, type MachineView, type ProjectRow, type Task, type TaskInput } from "./types.ts";

export interface AgentToken {
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}
/** Only the create response carries the token; it is never readable again. */
export interface NewAgentToken extends AgentToken {
  token: string;
}

// ponytail: augments the HTTP contract from here so types.ts stays untouched; move into Api when convenient.
declare module "./types.ts" {
  interface Api {
    "GET /api/agents": { body: never; res: AgentToken[] };
    "POST /api/agents": { body: { label: string }; res: NewAgentToken };
    "DELETE /api/agents/:label": { body: never; res: { ok: true } };
  }
}

// ---- tokens: only sha256(token) is stored ----

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function initAgentTokens(db: DatabaseSync) {
  db.exec(`create table if not exists agent_tokens(
    hash text primary key,
    label text not null unique collate nocase,
    created_at text not null,
    last_used_at text
  )`);
}

export function createAgentToken(db: DatabaseSync, label: unknown): NewAgentToken {
  if (typeof label !== "string" || !LABEL.test(label))
    throw new HttpError(400, "bad_request", "Label must be 1-40 letters, digits, dots, dashes or underscores");
  if (db.prepare("select 1 from agent_tokens where label = ?").get(label))
    throw new HttpError(409, "conflict", "An agent with that label exists; revoke it first");
  const token = `cc_${randomBytes(32).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  db.prepare("insert into agent_tokens(hash, label, created_at) values (?, ?, ?)").run(sha256(token), label, createdAt);
  return { label, createdAt, lastUsedAt: null, token };
}

export function listAgentTokens(db: DatabaseSync): AgentToken[] {
  return db
    .prepare("select label, created_at, last_used_at from agent_tokens order by created_at")
    .all()
    .map((r) => ({ label: r.label as string, createdAt: r.created_at as string, lastUsedAt: r.last_used_at as string | null }));
}

export function revokeAgentToken(db: DatabaseSync, label: string): boolean {
  return db.prepare("delete from agent_tokens where label = ? returning 1").get(label) !== undefined;
}

/** The agent label for a bearer token (and stamps last use), or null. Pass as createServer's verifyBearer. */
export function verifyAgentToken(db: DatabaseSync, token: string): string | null {
  const row = db.prepare("update agent_tokens set last_used_at = ? where hash = ? returning label").get(new Date().toISOString(), sha256(token));
  return row ? (row.label as string) : null;
}

// ---- tools ----

/** Throw from a tool handler for an `isError` result the agent can read. */
export class ToolError extends Error {}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  /** `agent` is the caller's label. The return value goes back as JSON text. */
  handler(args: Record<string, unknown>, agent: string): unknown;
}

export interface McpDeps {
  db: DatabaseSync;
  tasks: Pick<Dispatcher, "createTask" | "cancel">;
  /** Live machines (HomeView rows). */
  machines: () => MachineView[];
}

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_PROMPT = 20_000;

const norm = (path: string) => {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
};

/** Exact id, then the deepest workspace root containing `query` as a path, then a unique case-insensitive title. */
export function resolveProject(projects: ProjectRow[], query: string, machineLabel: (id: string) => string): ProjectRow {
  const one = (hits: ProjectRow[]) => {
    if (hits.length > 1) {
      const list = hits.slice(0, 5).map((p) => `${p.title} (id ${p.id} on ${machineLabel(p.machineId)}, ${p.workspaceRoot})`);
      throw new ToolError(`Ambiguous project "${query}"; pass machine or a project id. Candidates: ${list.join("; ")}`);
    }
    return hits[0];
  };
  const q = norm(query);
  const under = projects.filter((p) => {
    const root = norm(p.workspaceRoot);
    return root !== "" && (q === root || q.startsWith(`${root}/`));
  });
  const deepest = Math.max(0, ...under.map((p) => norm(p.workspaceRoot).length));
  const hit =
    one(projects.filter((p) => p.id === query)) ??
    one(under.filter((p) => norm(p.workspaceRoot).length === deepest)) ??
    one(projects.filter((p) => p.title.toLowerCase() === query.toLowerCase()));
  if (!hit) throw new ToolError(`Unknown project "${query}"; machines_list shows the projects`);
  return hit;
}

function str(args: Record<string, unknown>, key: string, max: number, optional: true): string | undefined;
function str(args: Record<string, unknown>, key: string, max: number): string;
function str(args: Record<string, unknown>, key: string, max: number, optional = false) {
  const v = args[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${key} must be a non-empty string`);
  if (v.length > max) throw new ToolError(`${key} must be at most ${max} characters`);
  return v;
}

const brief = (t: Task) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  machineId: t.machineId,
  projectId: t.projectId,
  createdAt: t.createdAt,
  finishedAt: t.finishedAt,
  error: t.error,
});

function taskTools({ db, tasks, machines }: McpDeps): ToolDef[] {
  const own = (agent: string, id: unknown) => {
    const task = typeof id === "string" ? getTask(db, id) : undefined;
    if (!task || task.source !== `agent:${agent}`) throw new ToolError("Task not found");
    return task;
  };
  const taskId = { type: "object", properties: { id: { type: "string", description: "Task id from task_submit or task_list." } }, required: ["id"] };

  return [
    {
      name: "task_submit",
      description:
        "Queue work for a coding agent on one of the user's T3 machines. The task waits for the user to approve it in the Command Center (they also pick its permissions), then runs in a new T3 thread. Follow it with task_status.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: `What the agent should do, self-contained. At most ${MAX_PROMPT} characters.` },
          title: { type: "string", description: "Short title; defaults to the prompt's first line." },
          project: { type: "string", description: "Project id, a path inside the project, or its title (see machines_list)." },
          machine: { type: "string", description: "Machine id or label, when the project exists on several machines." },
          model: {
            type: "object",
            description: "Defaults to the project's model.",
            properties: { instanceId: { type: "string" }, model: { type: "string" } },
            required: ["instanceId", "model"],
          },
          priority: { type: "integer", minimum: -2, maximum: 2, description: "Higher runs first; defaults to 0." },
          depends_on: { type: "array", items: { type: "string" }, maxItems: 20, description: "Ids of your tasks that must finish first; their results are appended to the prompt." },
        },
        required: ["prompt", "project"],
      },
      handler(args, agent) {
        const source = `agent:${agent}` as const;
        const prompt = str(args, "prompt", MAX_PROMPT);
        const title = str(args, "title", 200, true);
        const project = str(args, "project", 1000);
        const machine = str(args, "machine", 200, true);
        const all = listMachines(db);
        const labels = new Map(all.map((m) => [m.id, m.label]));
        let candidates = listProjects(db);
        if (machine !== undefined) {
          const ms = all.filter((m) => m.id === machine || m.label.toLowerCase() === machine.toLowerCase());
          if (ms.length !== 1) throw new ToolError(`${ms.length ? "Ambiguous" : "Unknown"} machine "${machine}"; machines: ${all.map((m) => m.label).join(", ")}`);
          candidates = candidates.filter((p) => p.machineId === ms[0]!.id);
        }
        const target = resolveProject(candidates, project, (id) => labels.get(id) ?? id);

        const m = args.model;
        if (m !== undefined && (typeof m !== "object" || m === null || typeof (m as { instanceId?: unknown }).instanceId !== "string" || typeof (m as { model?: unknown }).model !== "string"))
          throw new ToolError("model must be {instanceId, model}");
        const deps = args.depends_on ?? [];
        if (!Array.isArray(deps) || deps.length > 20) throw new ToolError("depends_on must be an array of at most 20 task ids");
        for (const id of deps) own(agent, id);

        // Built field by field: runtimeMode, interactionMode and workspace from the agent never get through.
        const input: TaskInput = {
          prompt,
          title,
          machineId: target.machineId,
          projectId: target.id,
          model: m ? { instanceId: (m as { instanceId: string }).instanceId, model: (m as { model: string }).model } : null,
          priority: args.priority as number | undefined,
          dependsOn: deps as string[],
        };
        return { ...brief(tasks.createTask(input, source)), note: "Waiting for the user's approval." };
      },
    },
    {
      name: "task_status",
      description: "One of your tasks: status and, once finished, the agent's final message (at most 4000 characters).",
      inputSchema: taskId,
      handler: (args, agent) => {
        const t = own(agent, args.id);
        return { ...brief(t), prompt: t.prompt, result: t.result, startedAt: t.startedAt };
      },
    },
    {
      name: "task_list",
      description: "Your 20 most recent tasks, newest first.",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, agent) =>
        db
          .prepare("select id from tasks where source = ? order by created_at desc limit 20")
          .all(`agent:${agent}`)
          .map((r) => brief(getTask(db, r.id as string)!)),
    },
    {
      name: "task_cancel",
      description: "Cancel one of your tasks; a running one is interrupted in T3.",
      inputSchema: taskId,
      handler: async (args, agent) => brief(await tasks.cancel(own(agent, args.id).id)),
    },
    {
      name: "machines_list",
      description: "The user's T3 machines with their link status, load and projects (use a project id or path with task_submit).",
      inputSchema: { type: "object", properties: {} },
      handler: () =>
        machines().map((m) => ({
          id: m.id,
          label: m.label,
          status: m.link.status,
          running: m.running,
          queued: m.queued,
          maxConcurrent: m.maxConcurrent,
          projects: listProjects(db, m.id).map((p) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot })),
        })),
    },
  ];
}

// ---- JSON-RPC 2.0 ----

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Agent-facing routes (POST /mcp, GET /mcp → 405) and cookie routes to manage tokens.
 * Wire `verifyBearer` into createServer. `registerTools` adds later phases' tools.
 */
export function createMcp(deps: McpDeps) {
  initAgentTokens(deps.db);
  const tools = new Map<string, ToolDef>();
  const registerTools = (defs: ToolDef[]) => {
    for (const d of defs) {
      if (tools.has(d.name)) throw new Error(`tool ${d.name} registered twice`);
      tools.set(d.name, d);
    }
  };
  registerTools(taskTools(deps));

  async function call(params: unknown, agent: string) {
    if (!isObj(params) || typeof params.name !== "string") throw new RpcError(-32602, "params.name required");
    const tool = tools.get(params.name);
    if (!tool) throw new RpcError(-32602, `Unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    if (!isObj(args)) throw new RpcError(-32602, "arguments must be an object");
    try {
      const out = await tool.handler(args, agent);
      return { content: [{ type: "text", text: JSON.stringify(out ?? null) }], isError: false };
    } catch (e) {
      const known = e instanceof ToolError || e instanceof TaskError || e instanceof T3Error;
      if (!known) console.error(`[cc] mcp tool ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { content: [{ type: "text", text: known ? (e as Error).message : "Internal error" }], isError: true };
    }
  }

  async function method(name: string, params: unknown, agent: string): Promise<unknown> {
    if (name === "initialize") {
      const asked = isObj(params) ? params.protocolVersion : undefined;
      return {
        protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "t3-command-center", version: "1.0.0" },
        instructions: "Submit work to the user's T3 machines. Every task waits for the user's approval.",
      };
    }
    if (name === "ping") return {};
    if (name === "tools/list") return { tools: [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    if (name === "tools/call") return call(params, agent);
    throw new RpcError(-32601, `Method not found: ${name}`);
  }

  /** One message → its response, or null for notifications and client responses. */
  async function one(msg: unknown, agent: string): Promise<object | null> {
    const id = isObj(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    if (!isObj(msg) || msg.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    if (typeof msg.method !== "string") return "result" in msg || "error" in msg ? null : { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    if (msg.id === undefined) return null; // notifications/*: nothing to do
    if (id === null) return { jsonrpc: "2.0", id, error: { code: -32600, message: "id must be a string or number" } };
    try {
      return { jsonrpc: "2.0", id, result: await method(msg.method, msg.params, agent) };
    } catch (e) {
      if (e instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message } };
      console.error(`[cc] mcp ${msg.method} failed: ${e instanceof Error ? e.message : String(e)}`);
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
    }
  }

  const routes: Route[] = [
    {
      method: "POST",
      path: "/mcp",
      auth: "bearer",
      handler: async ({ res, body, agent }) => {
        let out: unknown;
        if (Array.isArray(body) && body.length > 0) {
          const replies: object[] = [];
          for (const msg of body) {
            const r = await one(msg, agent!);
            if (r) replies.push(r);
          }
          out = replies.length ? replies : null;
        } else out = await one(body, agent!);
        if (out === null) return void res.writeHead(202, { "cache-control": "no-store" }).end();
        return out;
      },
    },
    {
      method: "GET",
      path: "/mcp",
      auth: "public",
      handler: ({ res }) => {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "method_not_allowed", "POST JSON-RPC to /mcp; this server does not stream");
      },
    },
    { method: "GET", path: "/api/agents", auth: "cookie", handler: () => listAgentTokens(deps.db) },
    {
      method: "POST",
      path: "/api/agents",
      auth: "cookie",
      handler: ({ body }) => createAgentToken(deps.db, isObj(body) ? body.label : undefined),
    },
    {
      method: "DELETE",
      path: "/api/agents/:label",
      auth: "cookie",
      handler: ({ params }) => {
        if (!revokeAgentToken(deps.db, params.label!)) throw new HttpError(404, "not_found", "agent not found");
        return { ok: true };
      },
    },
  ];

  return { routes, registerTools, verifyBearer: (token: string) => verifyAgentToken(deps.db, token) };
}
