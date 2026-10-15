// Orca executor: optional, off unless CC_ORCA_CLI points at the orca binary. CC_ORCA_ENV (a saved Orca
// environment id) is passed as --environment, so a CC on the VPS can drive the PC's Orca runtime.
// Launch and send are user actions only (cookie routes); they are never exposed to agents or MCP.
import { spawn } from "node:child_process";
import { HttpError, type Route } from "./http.ts";

export const TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 4 * 1024 * 1024;
export const MAX_ROWS = 50;
const PREVIEW = 160;
const SCREEN = 16_000;
const MAX_TEXT = 16_000; // Windows command lines cap at 32k chars

export interface OrcaTerminal {
  handle: string;
  title: string;
  /** "claude" | "codex" | ... ; null for a plain shell. */
  agent: string | null;
  connected: boolean;
  writable: boolean;
  lastOutputAt: number | null;
  preview: string;
}

export interface OrcaWorktree {
  id: string;
  name: string;
  path: string;
  branch: string;
  /** "local" or "ssh:<id>"; null when Orca did not say. */
  hostId: string | null;
  /** "working" | "active" | ... as Orca reports it. */
  status: string;
  unread: boolean;
  lastOutputAt: number | null;
  preview: string;
  terminals: OrcaTerminal[];
}

export interface OrcaStatus {
  configured: boolean;
  running: boolean;
  version: string | null;
  /** Why it is not running or could not be read. */
  message: string | null;
}

export interface OrcaList extends OrcaStatus {
  /** Live worktrees (with terminals or activity), newest output first. */
  worktrees: OrcaWorktree[];
  /** Repos on the runtime's own host, for the launch form. */
  repos: { name: string; path: string }[];
}

export interface OrcaLaunch {
  projectPath: string;
  agent: "codex" | "claude";
  name: string;
  prompt: string;
}

/** Type contract for the web (merge into Api when wiring). */
export interface OrcaApi {
  "GET /api/orca": { body: never; res: OrcaList };
  "POST /api/orca/launch": { body: OrcaLaunch; res: { worktreeId: string | null; handle: string | null } };
  "GET /api/orca/:handle": { body: never; res: { handle: string; source: string | null; text: string } };
  "POST /api/orca/:handle/send": { body: { text?: string; interrupt?: boolean }; res: { accepted: boolean | null } };
}

export type OrcaRunner = (args: string[]) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;

export class OrcaError extends Error {
  readonly code: "off" | "invalid" | "not_running" | "stale" | "timeout" | "failed";
  constructor(code: OrcaError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** On Windows the .exe, never the .cmd wrapper: cmd.exe reparses arguments and can run or cut newlines. */
export const cliFile = (cli: string, platform = process.platform) => (platform === "win32" ? cli.replace(/\.(cmd|bat)$/i, ".exe") : cli);

/** Args array, no shell, stdout capped, killed after the timeout. */
export function processRunner(cli: string, timeoutMs = TIMEOUT_MS, maxOutput = MAX_OUTPUT): OrcaRunner {
  const file = cliFile(cli);
  return (args) =>
    new Promise((ok, ko) => {
      const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= maxOutput) chunks.push(c);
        else child.kill();
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        ko(new OrcaError("failed", e.code === "ENOENT" ? "Orca CLI not found at CC_ORCA_CLI" : "Could not start the Orca CLI"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (size > maxOutput) return ko(new OrcaError("failed", "Orca answered with too much output"));
        ok({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut });
      });
    });
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as J) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clip = (s: unknown) => str(s).replace(/\s+/g, " ").trim().slice(-PREVIEW);
const branchOf = (s: unknown) => str(s).replace(/^refs\/heads\//, "");

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HANDLE = /^[\w.:-]{1,200}$/;

export interface OrcaDeps {
  /** Path to the orca binary; unset turns the feature off. */
  cli?: string;
  /** Remote runtime selector, passed as --environment. */
  environment?: string;
  /** Tests inject a fake. */
  run?: OrcaRunner;
}

export function createOrca(deps: OrcaDeps) {
  const run = deps.cli ? (deps.run ?? processRunner(deps.cli)) : null;
  const tail = deps.environment ? ["--json", `--environment=${deps.environment}`] : ["--json"];

  /** One CLI call, decoded from Orca's {ok, result | error} envelope. Handle commands map unknown handles to "re-list". */
  async function call(args: string[], handleCmd = false): Promise<J> {
    if (!run) throw new OrcaError("off", "Orca is off: set CC_ORCA_CLI on the server");
    const out = await run([...args, ...tail]);
    let env: J;
    try {
      env = obj(JSON.parse(out.stdout));
    } catch {
      throw out.timedOut
        ? new OrcaError("timeout", `Orca did not answer within ${TIMEOUT_MS / 1000} s`)
        : new OrcaError("failed", `Orca CLI failed (exit ${out.code ?? "killed"})`);
    }
    if (env.ok === true) return obj(env.result);
    const error = obj(env.error);
    const code = str(error.code);
    if (handleCmd && /stale|not_found/.test(code)) throw new OrcaError("stale", "That terminal is gone or its handle is stale; re-list.");
    throw new OrcaError("failed", str(error.message) || code || "Orca returned an error");
  }

  async function status(): Promise<OrcaStatus> {
    if (!run) return { configured: false, running: false, version: null, message: "Orca is off: set CC_ORCA_CLI on the server" };
    try {
      const runtime = obj((await call(["status"])).runtime);
      const running = runtime.reachable === true || runtime.state === "ready";
      return { configured: true, running, version: str(runtime.appVersion) || null, message: running ? null : "Orca is not running. Open it on its machine." };
    } catch (e) {
      return { configured: true, running: false, version: null, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Never starts Orca: actions refuse while the runtime is down. */
  async function ensureRunning() {
    const s = await status();
    if (!s.running) throw new OrcaError(s.configured ? "not_running" : "off", s.message ?? "Orca is not running");
  }

  let inflight: Promise<OrcaList> | null = null;
  function list(): Promise<OrcaList> {
    return (inflight ??= load().finally(() => (inflight = null)));
  }

  async function load(): Promise<OrcaList> {
    const s = await status();
    if (!s.running) return { ...s, worktrees: [], repos: [] };
    try {
      const [ps, tl] = await Promise.all([call(["worktree", "ps"]), call(["terminal", "list"])]);
      return { ...s, ...project(ps, tl) };
    } catch (e) {
      return { ...s, message: e instanceof Error ? e.message : String(e), worktrees: [], repos: [] };
    }
  }

  async function launch(input: unknown) {
    const { projectPath, agent, name, prompt } = obj(input);
    if (typeof projectPath !== "string" || !ABSOLUTE.test(projectPath) || projectPath.length > 1000) throw new OrcaError("invalid", "projectPath must be an absolute path");
    if (agent !== "codex" && agent !== "claude") throw new OrcaError("invalid", "agent must be codex or claude");
    if (typeof name !== "string" || !NAME.test(name)) throw new OrcaError("invalid", "name: letters, digits, . _ - (up to 64)");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_TEXT) throw new OrcaError("invalid", `prompt required (up to ${MAX_TEXT} characters)`);
    await ensureRunning();
    // --flag=value keeps a prompt that starts with "-" from reading as a flag.
    const r = await call(["worktree", "create", `--repo=path:${projectPath}`, `--name=${name}`, "--no-parent", `--agent=${agent}`, `--prompt=${prompt}`]);
    const handle = str(r.agentTerminalHandle) || str(obj(r.startupTerminal).handle) || null;
    return { worktreeId: str(obj(r.worktree).id) || null, handle };
  }

  async function read(handle: string) {
    if (!HANDLE.test(handle)) throw new OrcaError("invalid", "bad terminal handle");
    await ensureRunning();
    const r = await call(["terminal", "read", `--terminal=${handle}`, "--screen"], true);
    const term = obj(r.terminal);
    const raw = r.tail ?? term.tail ?? r.screen ?? r.text ?? r.output;
    const text = Array.isArray(raw) ? raw.map(str).join("\n") : str(raw);
    return { handle, source: str(r.source ?? term.source) || null, text: text.slice(-SCREEN) };
  }

  /** Sent once. A timeout is reported, never retried: the input may already be in the terminal. */
  async function send(handle: string, input: unknown) {
    const { text, interrupt } = obj(input);
    if (!HANDLE.test(handle)) throw new OrcaError("invalid", "bad terminal handle");
    if (text !== undefined && (typeof text !== "string" || text.length > MAX_TEXT)) throw new OrcaError("invalid", `text up to ${MAX_TEXT} characters`);
    if (!text && interrupt !== true) throw new OrcaError("invalid", "text or interrupt required");
    await ensureRunning();
    const args = ["terminal", "send", `--terminal=${handle}`];
    if (text) args.push(`--text=${text}`, "--enter");
    if (interrupt === true) args.push("--interrupt");
    try {
      const r = await call(args, true);
      const accepted = r.accepted ?? obj(r.send).accepted ?? obj(r.receipt).accepted;
      return { accepted: typeof accepted === "boolean" ? accepted : null };
    } catch (e) {
      if (e instanceof OrcaError && e.code === "timeout") throw new OrcaError("timeout", `${e.message}; the input may have arrived. Read the screen before sending again.`);
      throw e;
    }
  }

  const http = <T>(p: Promise<T>) => p.catch((e: unknown) => Promise.reject(toHttp(e)));
  const routes: Route[] = [
    { method: "GET", path: "/api/orca", auth: "cookie", handler: () => list() },
    { method: "POST", path: "/api/orca/launch", auth: "cookie", handler: ({ body }) => http(launch(body)) },
    { method: "GET", path: "/api/orca/:handle", auth: "cookie", handler: ({ params }) => http(read(params.handle!)) },
    { method: "POST", path: "/api/orca/:handle/send", auth: "cookie", handler: ({ params, body }) => http(send(params.handle!, body)) },
  ];
  return { status, list, launch, read, send, routes };
}

const STATUS: Record<OrcaError["code"], number> = { off: 404, invalid: 400, not_running: 409, stale: 409, timeout: 504, failed: 502 };
function toHttp(e: unknown): unknown {
  return e instanceof OrcaError ? new HttpError(STATUS[e.code], e.code === "failed" ? "orca_error" : e.code, e.message) : e;
}

/** `worktree ps` + `terminal list` down to ≤50 live worktrees with their terminals, and the launchable repos. */
export function project(ps: J, tl: J): Pick<OrcaList, "worktrees" | "repos"> {
  const rows = (Array.isArray(ps.worktrees) ? ps.worktrees : []).map(obj);
  const byId = new Map<string, OrcaWorktree>();
  for (const w of rows) {
    const id = str(w.worktreeId);
    const status = str(w.status) || "unknown";
    if (!id || w.isArchived === true || (status === "inactive" && !num(w.liveTerminalCount))) continue;
    byId.set(id, {
      id,
      name: str(w.displayName) || str(w.repo) || id,
      path: str(w.path),
      branch: branchOf(w.branch),
      hostId: str(w.hostId) || null,
      status,
      unread: w.unread === true,
      lastOutputAt: num(w.lastOutputAt),
      preview: clip(w.preview),
      terminals: [],
    });
  }
  for (const t of (Array.isArray(tl.terminals) ? tl.terminals : []).map(obj)) {
    const handle = str(t.handle);
    if (!handle || t.orphaned === true) continue;
    const wid = str(t.worktreeId);
    let w = byId.get(wid);
    if (!w) {
      // A terminal ps did not list (e.g. ps raced it): keep it under a minimal row.
      const path = str(t.worktreePath);
      w = { id: wid || handle, name: path.split(/[\\/]/).pop() || "Terminal", path, branch: branchOf(t.branch), hostId: str(t.executionHostId) || null, status: "active", unread: false, lastOutputAt: null, preview: "", terminals: [] };
      byId.set(w.id, w);
    }
    const term: OrcaTerminal = {
      handle,
      title: str(t.title) || handle,
      agent: str(t.agentIdentity) || null,
      connected: t.connected !== false,
      writable: t.writable === true,
      lastOutputAt: num(t.lastOutputAt),
      preview: clip(t.preview),
    };
    w.terminals.push(term);
    w.lastOutputAt = Math.max(w.lastOutputAt ?? 0, term.lastOutputAt ?? 0) || null;
  }
  const worktrees = [...byId.values()].sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)).slice(0, MAX_ROWS);
  for (const w of worktrees) w.terminals.sort((a, b) => (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0));

  const seen = new Set<string>();
  const repos = rows
    .filter((w) => (w.isMainWorktree === true || w.workspaceKind === "folder-workspace") && (!w.hostId || w.hostId === "local") && str(w.path))
    .sort((a, b) => (num(b.lastActivityAt) ?? 0) - (num(a.lastActivityAt) ?? 0))
    .flatMap((w) => (seen.has(str(w.path)) ? [] : (seen.add(str(w.path)), [{ name: str(w.displayName) || str(w.repo), path: str(w.path) }])))
    .slice(0, MAX_ROWS);
  return { worktrees, repos };
}
