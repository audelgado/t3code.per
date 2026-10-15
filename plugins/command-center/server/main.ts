// Composition root and CLI: `node server/main.ts <serve|pair|machine add|machine list|machine rm>`.
// Env: CC_HOME (default ./data), CC_PORT (default 3900), CC_PUBLIC_URL (required for serve and pair),
// CC_PUSH_SUBJECT (mailto: or https: contact for Web Push; defaults to CC_PUBLIC_URL),
// CC_ORCA_CLI (optional path to the orca binary), CC_ORCA_ENV (optional Orca environment id).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { mintPairing } from "./auth.ts";
import { deleteMachine, getMachine, getTask, listMachines, listProjects, listTasks, openDb, readToken, updateMachine, upsertMachine, writeToken } from "./db.ts";
import { artifactRoutes, artifactTools, openArtifacts } from "./artifacts.ts";
import { Dispatcher, TaskError } from "./dispatcher.ts";
import { createHealth } from "./health.ts";
import { createFinance } from "./finance.ts";
import { createServer, HttpError, sse, type Route } from "./http.ts";
import { createInfra } from "./infra.ts";
import { createAgentToken, createMcp, initAgentTokens, listAgentTokens, resolveProject, revokeAgentToken, ToolError } from "./mcp.ts";
import { memoryRoutes, memoryTools } from "./memory.ts";
import { createOrca } from "./orca.ts";
import { applyProfile, createProfileRoutes, initProfiles, profileTools } from "./profiles.ts";
import { createPush } from "./push.ts";
import { createSections } from "./sections.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import { createLink, threadLinks } from "./t3link.ts";
import { threadRoutes } from "./threadActions.ts";
import { T3Error, type HomeView, type LinkFactory, type LinkState, type Machine, type MachineProjects, type RuntimeMode, type T3Link, type TaskInput, type TaskSource, type ThreadStatus } from "./types.ts";
import { buildHomeView, hashView } from "./view.ts";
import { createWork } from "./work.ts";
import { createWorkflows } from "./workflows.ts";

export interface Config {
  home: string;
  port: number;
  publicUrl: string;
  /** VAPID subject; defaults to publicUrl. */
  pushSubject?: string;
  staticDir?: string;
  /** Path to the orca binary; unset turns the Orca screen off. */
  orcaCli?: string;
  /** Orca environment id (--environment), to drive another machine's runtime. */
  orcaEnvironment?: string;
}

const RECONCILE_MS = 5_000;
const VIEW_TICK_MS = 30_000;
const ACTIVE_RUN = new Set<ThreadStatus>(["preparing", "queued", "starting", "running", "waiting"]);
const log = (line: string) => console.log(`[cc] ${line}`);

function publicUrlOf(env: NodeJS.ProcessEnv): string {
  const raw = env.CC_PUBLIC_URL;
  if (!raw) throw new Error("CC_PUBLIC_URL is required, e.g. https://vps.tailnet.ts.net:8443");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("CC_PUBLIC_URL must be an http(s) URL");
  return url.origin;
}

function portOf(env: NodeJS.ProcessEnv): number {
  const port = Number(env.CC_PORT ?? 3900);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("CC_PORT must be a port number");
  return port;
}

const homeOf = (env: NodeJS.ProcessEnv) => resolve(env.CC_HOME || "data");

/** Token files 0600 and their dir 0700, also when an operator copied them in by hand. */
function enforcePermissions(home: string) {
  if (process.platform === "win32") return;
  const dir = join(home, "tokens");
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o700);
  for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600);
}

/** Starts the HTTP server, one link per enabled machine with a token, and the dispatcher. */
export async function serve(cfg: Config, linkFactory: LinkFactory = createLink) {
  const db = openDb(cfg.home);
  enforcePermissions(cfg.home);

  interface Entry {
    link: T3Link;
    /** sha256 of apiUrl + token: a re-added machine (new token or URL) gets a fresh link. */
    key: string;
    status: LinkState["status"] | null;
  }
  const links = new Map<string, Entry>();
  const dispatcher = new Dispatcher({ db, link: (id) => links.get(id)?.link });
  const push = createPush({ db, home: cfg.home, subject: cfg.pushSubject || cfg.publicUrl });
  const health = createHealth({
    db,
    targets: () =>
      listMachines(db).flatMap((machine) => {
        const link = machine.enabled ? links.get(machine.id)?.link : undefined;
        return link ? [{ machine, link }] : [];
      }),
  });

  function onState(machine: Machine, entry: Entry, state: LinkState) {
    if (links.get(machine.id) !== entry) return; // a replaced link
    if (state.status !== entry.status) log(`${machine.label}: ${state.status}${state.message ? ` (${state.message})` : ""}`);
    if (state.serverVersion && state.serverVersion !== getMachine(db, machine.id)?.serverVersion)
      updateMachine(db, machine.id, { serverVersion: state.serverVersion });
    if (state.status === "online" && entry.status !== "online") {
      entry.link.session().then(
        (s) => links.get(machine.id) === entry && updateMachine(db, machine.id, { tokenExpiresAt: s.expiresAt }),
        () => {}, // the link reports unauthorized itself
      );
    }
    entry.status = state.status;
    dispatcher.onState(machine.id, state);
  }

  function reconcile() {
    const wanted = new Set<string>();
    for (const machine of listMachines(db)) {
      const token = machine.enabled ? readToken(cfg.home, machine.id) : null;
      if (!token) continue;
      wanted.add(machine.id);
      const key = createHash("sha256").update(`${machine.apiUrl}\0${token}`).digest("hex");
      const current = links.get(machine.id);
      if (current?.key === key) continue;
      current?.link.close();
      const entry = { key, status: null } as Entry;
      links.set(machine.id, entry);
      entry.link = linkFactory(machine, token, {
        onState: (_id, state) => onState(machine, entry, state),
        onShell: (id, shell) => {
          if (links.get(id) !== entry) return;
          dispatcher.onShell(id, shell).catch((e: unknown) => log(`${machine.label}: shell update failed: ${e instanceof Error ? e.message : String(e)}`));
        },
      });
    }
    for (const [id, entry] of links) {
      if (wanted.has(id)) continue;
      entry.link.close();
      links.delete(id);
    }
  }

  function view(): HomeView {
    const machines = listMachines(db);
    const linkStates: Record<string, LinkState> = {};
    for (const m of machines) {
      linkStates[m.id] = links.get(m.id)?.link.state ?? {
        status: m.enabled ? "unauthorized" : "offline",
        since: m.createdAt,
        degraded: false,
        droppedRows: 0,
        unknownItems: 0,
        serverVersion: m.serverVersion,
        message: m.enabled ? "No token; run `machine add` again." : "Disabled.",
      };
    }
    // The view alerts from machine.tokenExpiresAt itself; health's daily expiry only fills in when that is unknown.
    const known = new Set(machines.filter((m) => m.tokenExpiresAt).map((m) => `token_expiring:${m.id}`));
    const extraAlerts = health.alerts().filter((a) => !known.has(a.key));
    // ponytail: every task on each build (blockedBy needs old deps); add a history cutoff if tasks reach tens of thousands.
    return buildHomeView(
      { machines, linkStates, projects: listProjects(db), threads: dispatcher.threads(), tasks: listTasks(db), pauses: dispatcher.pauses(), extraAlerts, workflowNeeds: workflows.needs(), threadLinks },
      Date.now(),
    );
  }

  // SSE: whole view, only when its hash changes, at most once per second.
  const clients = new Set<(data: unknown) => void>();
  let lastHash = "";
  let lastSent = 0;
  let pending: NodeJS.Timeout | null = null;
  function broadcast(v = view()): HomeView {
    const hash = hashView(v);
    if (hash !== lastHash) {
      lastHash = hash;
      lastSent = Date.now();
      for (const send of clients) send(v);
    }
    return v;
  }
  function pulse() {
    pending ??= setTimeout(() => {
      pending = null;
      // Built on every pulse, not only with SSE clients: push diffs each view.
      const v = view();
      push.notify(v).catch(() => {});
      broadcast(v);
    }, Math.max(0, lastSent + 1_000 - Date.now()));
  }
  dispatcher.on("changed", pulse);

  const task = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      throw toHttp(e);
    }
  };
  initProfiles(db);
  // Agent submissions go through the same profile resolution as the web; agents never set a runtime mode.
  const tasks = {
    createTask: (input: TaskInput, source: TaskSource) => dispatcher.createTask(applyProfile(db, input, source), source),
    cancel: (id: string) => dispatcher.cancel(id),
    approve: (id: string, o: Parameters<Dispatcher["approve"]>[1]) => dispatcher.approve(id, o),
  };
  const mcp = createMcp({ db, tasks, machines: () => view().machines });
  const sections = createSections(db, { HttpError, ToolError, resolveProject }, (id) => getMachine(db, id)?.label ?? id);
  const artifacts = openArtifacts(db, cfg.home);
  const workflows = createWorkflows({ db, tasks, link: (id) => links.get(id)?.link, threads: () => dispatcher.threads(), onChange: pulse });
  dispatcher.on("changed", workflows.advance);
  mcp.registerTools([...memoryTools(db), ...sections.tools, ...profileTools(db), ...artifactTools(artifacts), ...workflows.tools]);
  const work = createWork({
    machines: () => view().machines,
    projects: () => listProjects(db),
    threads: () => dispatcher.threads(),
    tasks: () => listTasks(db),
    link: (id) => links.get(id)?.link,
    createTask: (input) => dispatcher.createTask(input, "user"),
  });
  const orca = createOrca({ cli: cfg.orcaCli, environment: cfg.orcaEnvironment });
  const infra = createInfra({ machines: () => view().machines, link: (id) => links.get(id)?.link });
  const routes: Route[] = [
    ...push.routes,
    ...mcp.routes,
    ...memoryRoutes(db),
    ...sections.routes,
    ...createProfileRoutes({ db, tasks: dispatcher }),
    ...createFinance(db).routes,
    ...infra.routes,
    ...work.routes,
    ...artifactRoutes(artifacts),
    ...workflows.routes,
    ...orca.routes,
    // Cheap flags for the UI (GET /api/orca runs the CLI).
    { method: "GET", path: "/api/features", auth: "cookie", handler: () => ({ orca: Boolean(cfg.orcaCli) }) },
    { method: "GET", path: "/api/settings/projects", auth: "cookie", handler: () => loadSettings(db) },
    {
      method: "PUT",
      path: "/api/settings/projects",
      auth: "cookie",
      handler: ({ body }) => {
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "bad_request", "JSON object required");
        return saveSettings(db, body);
      },
    },
    ...threadRoutes({ links: (id) => links.get(id)?.link, threads: () => dispatcher.threads() }),
    { method: "GET", path: "/api/view", auth: "cookie", handler: () => view() },
    {
      method: "GET",
      path: "/api/events",
      auth: "cookie",
      handler: ({ res }) =>
        sse(res, (send) => {
          send(broadcast()); // also brings existing clients up to date
          clients.add(send);
          return () => clients.delete(send);
        }),
    },
    {
      method: "GET",
      path: "/api/projects",
      auth: "cookie",
      handler: (): MachineProjects[] =>
        listMachines(db).map((m) => ({
          machineId: m.id,
          machineLabel: m.label,
          status: links.get(m.id)?.link.state.status ?? "offline",
          projects: listProjects(db, m.id),
        })),
    },
    {
      method: "POST",
      path: "/api/tasks",
      auth: "cookie",
      handler: ({ body }) => {
        if (typeof body !== "object" || body === null) throw new HttpError(400, "bad_request", "JSON body required");
        return task(() => dispatcher.createTask(applyProfile(db, body as TaskInput, "user"), "user"));
      },
    },
    {
      method: "GET",
      path: "/api/tasks/:id",
      auth: "cookie",
      handler: ({ params }) => getTask(db, params.id!) ?? notFound("task"),
    },
    {
      method: "PATCH",
      path: "/api/tasks/:id",
      auth: "cookie",
      handler: ({ params, body }) => task(() => dispatcher.setPriority(params.id!, (body as { priority?: number } | undefined)?.priority as number)),
    },
    {
      method: "POST",
      path: "/api/tasks/:id/cancel",
      auth: "cookie",
      handler: ({ params }) => dispatcher.cancel(params.id!).catch((e: unknown) => Promise.reject(toHttp(e))),
    },
    { method: "POST", path: "/api/tasks/:id/retry", auth: "cookie", handler: ({ params }) => task(() => dispatcher.retry(params.id!)) },
    {
      method: "POST",
      path: "/api/tasks/:id/approve",
      auth: "cookie",
      handler: ({ params, body }) =>
        task(() => dispatcher.approve(params.id!, { runtimeMode: (body as { runtimeMode?: RuntimeMode } | undefined)?.runtimeMode })),
    },
    { method: "POST", path: "/api/tasks/:id/reject", auth: "cookie", handler: ({ params }) => task(() => dispatcher.reject(params.id!)) },
    { method: "GET", path: "/api/machines", auth: "cookie", handler: () => view().machines },
    {
      method: "GET",
      path: "/api/machines/:id/providers",
      auth: "cookie",
      handler: async ({ params }) => {
        if (!getMachine(db, params.id!)) notFound("machine");
        const link = links.get(params.id!)?.link;
        if (link?.state.status !== "online") throw new HttpError(409, "offline", "Machine is not online");
        return link.providers().catch((e: unknown) => Promise.reject(toHttp(e)));
      },
    },
  ];

  reconcile();
  const server = await createServer({
    routes,
    publicUrl: cfg.publicUrl,
    db,
    staticDir: cfg.staticDir ?? fileURLToPath(new URL("../web/dist", import.meta.url)),
    port: cfg.port,
    verifyBearer: mcp.verifyBearer,
    activeRuns: () => {
      const runs: Record<string, number> = {};
      for (const m of listMachines(db)) runs[m.id] = 0;
      for (const row of dispatcher.threads())
        if (row.machineId in runs && (row.activeRunId !== null || ACTIVE_RUN.has(row.status))) runs[row.machineId]!++;
      return runs;
    },
  });
  dispatcher.start();
  workflows.advance();
  // ponytail: polls the local DB and token files so `machine add|rm` from the CLI apply without a restart.
  const timers = [
    setInterval(reconcile, RECONCILE_MS),
    setInterval(() => {
      void health.tick(); // single-flight, never rejects
      pulse();
    }, VIEW_TICK_MS),
  ];
  const port = (server.address() as AddressInfo).port;
  log(`listening on 127.0.0.1:${port}, public ${cfg.publicUrl}`);

  return {
    port,
    reconcile,
    async close() {
      for (const t of timers) clearInterval(t);
      if (pending) clearTimeout(pending);
      dispatcher.stop();
      for (const entry of links.values()) entry.link.close();
      links.clear();
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      db.close();
    },
  };
}

function notFound(what: string): never {
  throw new HttpError(404, "not_found", `${what} not found`);
}

function toHttp(e: unknown): unknown {
  if (e instanceof TaskError) return new HttpError(e.code === "invalid" ? 400 : e.code === "not_found" ? 404 : 409, e.code, e.message);
  if (e instanceof T3Error) return new HttpError(502, "t3_error", e.message);
  return e;
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** The whole of stdin (machine add reads the T3 token from it). */
  stdin?: () => Promise<string>;
  out?: (line: string) => void;
  linkFactory?: LinkFactory;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Paste the T3 token, then press Ctrl-D:\n");
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

const USAGE = `usage: node server/main.ts <command>
  serve                                      run the Command Center
  pair                                       print a single-use pairing link (5 min)
  machine add <apiUrl> [--web-url <url>] [--max <n>] [--label <name>]
                                             add or update a T3 environment; the token comes from stdin
  machine list                               list machines (never prints tokens)
  machine rm <id>                            remove a machine and its token file
  agent-token add <label>                    create an MCP bearer token for an agent (printed once)
  agent-token list                           list agent tokens (never prints tokens)
  agent-token rm <label>                     revoke an agent token`;

/** Runs one CLI command. Resolves to the exit code; `serve` resolves once listening and keeps running. */
export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => console.log(line));
  const home = homeOf(env);
  const [cmd, sub] = argv;
  process.umask(0o077); // the DB, its WAL and token files are private to the CC user

  if (cmd === "serve") {
    const handle = await serve({ home, port: portOf(env), publicUrl: publicUrlOf(env), pushSubject: env.CC_PUSH_SUBJECT, orcaCli: env.CC_ORCA_CLI || undefined, orcaEnvironment: env.CC_ORCA_ENV || undefined }, deps.linkFactory);
    const stop = () => void handle.close().then(() => process.exit(0));
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return 0;
  }

  if (cmd === "pair") {
    const publicUrl = publicUrlOf(env);
    const db = openDb(home);
    try {
      out(`${publicUrl}/pair#token=${mintPairing(db)}`);
      out("Open it on the phone within 5 minutes. It works once.");
    } finally {
      db.close();
    }
    return 0;
  }

  if (cmd === "agent-token" && (sub === "add" || sub === "list" || sub === "rm")) {
    const label = argv[2];
    if (sub !== "list" && !label) throw new Error(`agent-token ${sub} needs a label
${USAGE}`);
    const db = openDb(home);
    try {
      initAgentTokens(db);
      if (sub === "list") {
        for (const a of listAgentTokens(db)) out(`${a.label}  created=${a.createdAt}  used=${a.lastUsedAt ?? "never"}`);
      } else if (sub === "add") {
        const { token } = createAgentToken(db, label);
        out(token);
        out(`Bearer token for ${label}; it is not shown again. Every task it submits waits for your approval.`);
      } else {
        if (!revokeAgentToken(db, label!)) throw new Error(`no agent ${label}`);
        out(`Revoked ${label}.`);
      }
      return 0;
    } finally {
      db.close();
    }
  }

  if (cmd === "machine" && (sub === "add" || sub === "list" || sub === "rm")) {
    const { values, positionals } = parseArgs({
      args: argv.slice(2),
      allowPositionals: true,
      options: { "web-url": { type: "string" }, max: { type: "string" }, label: { type: "string" } },
    });
    const db = openDb(home);
    try {
      if (sub === "list") {
        for (const m of listMachines(db)) {
          const token = readToken(home, m.id) ? "token ok" : "NO TOKEN";
          out(
            `${m.id}  ${m.label}  ${m.apiUrl}  web=${m.webUrl ?? "-"}  max=${m.maxConcurrent}  ${m.enabled ? "enabled" : "disabled"}  ` +
              `t3=${m.serverVersion ?? "?"}  expires=${m.tokenExpiresAt ?? "?"}  ${token}`,
          );
        }
        return 0;
      }
      const [arg] = positionals;
      if (!arg) throw new Error(`machine ${sub} needs an argument\n${USAGE}`);

      if (sub === "rm") {
        if (!getMachine(db, arg)) throw new Error(`no machine ${arg}`);
        deleteMachine(db, home, arg);
        out(`Removed ${arg} and its token.`);
        return 0;
      }

      const apiUrl = new URL(arg).origin;
      const webUrl = values["web-url"] ? new URL(values["web-url"]).origin : null;
      const max = values.max === undefined ? undefined : Number(values.max);
      if (max !== undefined && !(Number.isInteger(max) && max >= 1 && max <= 20)) throw new Error("--max must be 1-20");
      const token = (await (deps.stdin ?? readStdin)()).trim();
      if (!token) throw new Error("no token on stdin; pipe the output of `t3 auth session issue ... --token-only`");
      const res = await (deps.fetch ?? fetch)(new URL("/.well-known/t3/environment", apiUrl), { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`${apiUrl} answered HTTP ${res.status} for its environment descriptor`);
      const desc = (await res.json()) as { environmentId?: unknown; label?: unknown; serverVersion?: unknown };
      if (typeof desc.environmentId !== "string") throw new Error(`${apiUrl} is not a T3 server (no environmentId)`);
      const id = desc.environmentId;
      const existing = getMachine(db, id);
      writeToken(home, id, token); // first: it rejects ids that are not safe file names
      upsertMachine(db, {
        id,
        label: values.label ?? existing?.label ?? (typeof desc.label === "string" ? desc.label : new URL(apiUrl).hostname),
        apiUrl,
        webUrl: webUrl ?? existing?.webUrl ?? null,
        maxConcurrent: max ?? existing?.maxConcurrent ?? 2,
        enabled: true,
        serverVersion: typeof desc.serverVersion === "string" ? desc.serverVersion : null,
        // A new token: the server reads its expiry once the link is online.
        tokenExpiresAt: null,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      });
      out(`${existing ? "Updated" : "Added"} ${id}. A running server picks it up within ${RECONCILE_MS / 1000} s.`);
      return 0;
    } finally {
      db.close();
    }
  }

  out(USAGE);
  return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    },
  );
}
