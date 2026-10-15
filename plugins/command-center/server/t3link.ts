// The only file that knows T3: routes, the Effect-RPC JSON wire, payload shapes and deep links.
// Every T3 fact used here is listed in T3_CONTRACT so `npm run contract-check` notices upstream drift.
import { randomUUID } from "node:crypto";
import { T3Error } from "./types.ts";
import type {
  ActivityRunStatus,
  ApprovalDecision,
  LinkEvents,
  LinkState,
  Machine,
  PendingRequest,
  ProjectRow,
  ProviderInfo,
  SessionInfo,
  T3Link,
  ThreadResult,
  ThreadRow,
  ThreadStatus,
} from "./types.ts";

const SUPPORTED_PROTOCOLS = [2];
const PROTOCOL_HEADER = "x-t3-orchestration-protocol";
const RPC_TIMEOUT_MS = 30_000;
const PING_MS = 10_000;
const RECHECK_MS = 10 * 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const RESULT_MAX = 4_000;
const SUMMARY_MAX = 1_000;

/** The subset of the WHATWG WebSocket the link uses (global WebSocket in Node ≥22). */
export interface WsLike {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LinkDeps {
  WebSocketImpl?: new (url: string) => WsLike;
  fetchImpl?: typeof fetch;
  /** Every raw WebSocket frame (contract-check --record). Frames never carry the bearer token. */
  onFrame?: (direction: "in" | "out", data: string) => void;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// ---- Lenient mappers: unknown fields are ignored, a row without id/status is dropped (null). ----

/** A pull request as the Work view shows it; state null while T3 has not synced it. */
export interface WorkPr {
  number: number;
  url: string;
  state: "open" | "closed" | "merged" | null;
  isDraft: boolean;
}

/** Branch fields toThreadRow adds for the Work view (merge into ThreadRow in types.ts when wiring). */
export interface WorkFields {
  branch: string | null;
  worktreePath: string | null;
  /** The thread's pull request on its own branch, from the shell's PR links. */
  pr: WorkPr | null;
}

const prState = (v: unknown): WorkPr["state"] => (v === "open" || v === "closed" || v === "merged" ? v : null);
const toPr = (p: Json | null, state: unknown, isDraft: unknown): WorkPr | null =>
  p && typeof p.number === "number" && str(p.url) ? { number: p.number, url: str(p.url)!, state: prState(state), isDraft: isDraft === true } : null;

/** A synced link on the thread's branch (the branch/linked PR first, else the newest), else the bare branch/linked PR. */
function shellPr(t: Json, branch: string | null): WorkPr | null {
  const legacy = obj(t.branchPullRequest) ?? obj(t.linkedPullRequest);
  const links = arr(t.pullRequests).flatMap((raw) => {
    const link = obj(raw);
    const snap = obj(link?.snapshot);
    return link && snap && link.source !== "stack-dismissed" && branch && snap.headBranch === branch ? [{ link, snap }] : [];
  });
  const when = (x: (typeof links)[number]) => String(x.snap.syncedAt ?? x.link.linkedAt ?? "");
  const pick =
    links.find(({ link }) => legacy && link.number === legacy.number && link.url === legacy.url) ??
    links.sort((a, b) => when(b).localeCompare(when(a)))[0];
  return pick ? toPr(pick.link, pick.snap.state, pick.snap.isDraft) : toPr(legacy, null, false);
}

export function toThreadRow(machineId: string, raw: unknown): (ThreadRow & WorkFields) | null {
  const t = obj(raw);
  const id = str(t?.id);
  const status = str(t?.status);
  if (!t || !id || !status) return null;
  const pending = obj(t.pendingRuntimeRequest);
  const rel = obj(t.lineage)?.relationshipToParent;
  return {
    machineId,
    id,
    projectId: str(t.projectId) ?? "",
    title: str(t.title) ?? "",
    status: status as ThreadStatus,
    activityRunStatus: str(t.activityRunStatus) as ActivityRunStatus | null,
    activeRunId: str(t.activeRunId),
    pendingRequest: pending && str(pending.id) ? toPending(pending, null) : null,
    hasActionableProposedPlan: t.hasActionableProposedPlan === true,
    lastError: str(t.lastError),
    usageLimitResetAt: str(t.usageLimitResetAt),
    relationshipToParent: rel === "fork" || rel === "subagent" ? rel : null,
    snoozedUntil: str(t.snoozedUntil),
    settledAt: str(t.settledAt),
    providerInstanceId: str(t.providerInstanceId) ?? str(obj(t.modelSelection)?.instanceId) ?? "",
    completedAt: str(t.latestRunCompletedAt),
    createdAt: str(t.createdAt) ?? "",
    updatedAt: str(t.updatedAt) ?? "",
    branch: str(t.branch),
    worktreePath: str(t.worktreePath),
    pr: shellPr(t, str(t.branch)),
  };
}

export function toProjectRow(machineId: string, raw: unknown): ProjectRow | null {
  const p = obj(raw);
  const id = str(p?.id);
  if (!p || !id) return null;
  const model = obj(p.defaultModelSelection);
  return {
    machineId,
    id,
    title: str(p.title) ?? "",
    workspaceRoot: str(p.workspaceRoot) ?? "",
    defaultModel:
      model && str(model.instanceId) && str(model.model)
        ? (model as unknown as ProjectRow["defaultModel"])
        : null,
    updatedAt: str(p.updatedAt) ?? "",
  };
}

/** HostResourcesSnapshot (server.getHostResources): whole-host CPU and memory. */
export interface HostResources {
  sampledAt: string;
  /** 0..1, null while T3 has no CPU sample yet. */
  cpuUtilization: number | null;
  cpuCount: number;
  availableMemoryBytes: number;
  totalMemoryBytes: number;
}

/** What createLink adds beyond T3Link (merge into T3Link in types.ts when wiring). */
export interface HostLink {
  hostResources(): Promise<HostResources>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function toHostResources(raw: unknown): HostResources {
  const h = obj(raw);
  const sampledAt = num(h?.sampledAt);
  return {
    sampledAt: new Date(sampledAt ?? Date.now()).toISOString(),
    cpuUtilization: num(h?.cpuUtilization),
    cpuCount: num(h?.cpuCount) ?? 0,
    availableMemoryBytes: num(h?.availableMemoryBytes) ?? 0,
    totalMemoryBytes: num(h?.totalMemoryBytes) ?? 0,
  };
}

/** One checkout's git status as T3 last saw it. */
export interface VcsStatus {
  refName: string | null;
  isDefaultRef: boolean;
  hasPrimaryRemote: boolean;
  /** Changed files in the working tree, 0 when clean. */
  changedFiles: number;
  /** Null while T3 holds no remote status for this checkout: the CC never asks it to fetch. */
  remote: {
    hasUpstream: boolean;
    aheadCount: number;
    behindCount: number;
    /** Commits ahead of the default branch; null when T3 did not report it. */
    aheadOfDefaultCount: number | null;
    pr: WorkPr | null;
  } | null;
}

/** First VcsStatusStreamEvent ("snapshot") → status; null when the path is not a repository. */
export function toVcsStatus(raw: unknown): VcsStatus | null {
  const e = obj(raw);
  const local = obj(e?.local);
  const remote = obj(e?.remote);
  if (e?._tag !== "snapshot" || local?.isRepo !== true) return null;
  const pr = obj(remote?.pr);
  return {
    refName: str(local.refName),
    isDefaultRef: local.isDefaultRef === true,
    hasPrimaryRemote: local.hasPrimaryRemote === true,
    changedFiles: local.hasWorkingTreeChanges === true ? Math.max(1, arr(obj(local.workingTree)?.files).length) : 0,
    remote: remote && {
      hasUpstream: remote.hasUpstream === true,
      aheadCount: num(remote.aheadCount) ?? 0,
      behindCount: num(remote.behindCount) ?? 0,
      aheadOfDefaultCount: num(remote.aheadOfDefaultCount),
      pr: toPr(pr, pr?.state, pr?.isDraft),
    },
  };
}

/** A merged pull request from pullRequests.list. */
export interface MergedPr {
  projectId: string;
  headBranch: string;
  number: number;
  url: string;
}

/** Read-only VCS/PR calls for the Work view (merge into T3Link in types.ts when wiring). */
export interface WorkLink {
  /** Local status plus T3's cached remote status; never fetches, pulls or writes. */
  vcsStatus(cwd: string): Promise<VcsStatus | null>;
  /** Merged pull requests of these projects (≤100), newest first. */
  mergedPullRequests(projectIds: string[]): Promise<MergedPr[]>;
}

/** Workspace file reads for workflow import; both need the token's filesystem:read scope. */
export interface FileLink {
  /** Immediate children of `directoryPath` (workspace-relative, "" = root). */
  listEntries(cwd: string, directoryPath: string): Promise<{ path: string; kind: "file" | "directory" }[]>;
  /** A workspace-relative file; `truncated` when T3 cut it. */
  readFile(cwd: string, relativePath: string): Promise<{ contents: string; truncated: boolean }>;
}

const toPending = (r: Json, summary: string | null): PendingRequest => ({
  id: String(r.id),
  kind: str(r.kind) ?? "unknown",
  summary,
  createdAt: str(r.createdAt) ?? "",
});

// ---- Shell reducer (port of client-runtime shellReducer.ts mergeShellSnapshotProjects + applyShellStreamEvent) ----

export interface ShellState {
  /** null until the first authoritative snapshot. */
  sequence: number | null;
  projects: Map<string, ProjectRow>;
  threads: Map<string, ThreadRow>;
}

export interface ShellCounters {
  droppedRows: number;
  unknownItems: number;
}

export const emptyShell = (): ShellState => ({ sequence: null, projects: new Map(), threads: new Map() });

/** Applies one ShellStreamItem in place. Returns what changed, or null when nothing did. */
export function applyShellItem(
  machineId: string,
  state: ShellState,
  raw: unknown,
  counters: ShellCounters,
): "authoritative" | "delta" | null {
  const item = obj(raw);
  const kind = str(item?.kind);
  if (!item || !kind) {
    counters.unknownItems++;
    return null;
  }
  if (kind === "synchronized") return null;
  if (kind === "snapshot") {
    const snap = obj(item.snapshot);
    if (!snap || typeof snap.snapshotSequence !== "number") {
      counters.unknownItems++;
      return null;
    }
    // Enrichment frames (threads: [], filtered projects) only patch repository identity,
    // which ProjectRow does not carry: never replace rows or the sequence from them.
    if (item.resolvedRepositoryIdentityRoots !== undefined) return null;
    state.projects.clear();
    state.threads.clear();
    for (const p of arr(snap.projects)) put(state.projects, toProjectRow(machineId, p), counters);
    for (const t of arr(snap.threads)) put(state.threads, toThreadRow(machineId, t), counters);
    state.sequence = snap.snapshotSequence;
    return "authoritative";
  }
  const sequence = item.sequence;
  if (typeof sequence !== "number") {
    counters.unknownItems++;
    return null;
  }
  if (state.sequence === null || sequence <= state.sequence) return null;
  switch (kind) {
    case "project.updated":
      put(state.projects, toProjectRow(machineId, item.project), counters);
      break;
    case "project.removed":
      state.projects.delete(String(item.projectId));
      break;
    case "thread.updated":
      if (item.location === "active") put(state.threads, toThreadRow(machineId, item.thread), counters);
      else state.threads.delete(String(obj(item.thread)?.id));
      break;
    case "thread.removed":
      state.threads.delete(String(item.threadId));
      break;
    default:
      counters.unknownItems++;
      return null;
  }
  state.sequence = sequence;
  return "delta";
}

function put<T extends { id: string }>(map: Map<string, T>, row: T | null, counters: ShellCounters) {
  if (row) map.set(row.id, row);
  else counters.droppedRows++;
}

// ---- RPC exit decoding ----

/** Effect RPC encoded Exit → null on Success, else the T3Error plus the failure's _tag. */
export function exitFailure(exit: unknown): { error: T3Error; tag: string | null } | null {
  const e = obj(exit);
  if (e?._tag === "Success") return null;
  const causes = arr(e?.cause).map(obj);
  const fail = causes.find((c) => c?._tag === "Fail");
  if (fail) {
    const err = obj(fail.error);
    const tag = str(err?._tag);
    return { error: new T3Error("fail", str(err?.message) ?? tag ?? "T3 rejected the request."), tag };
  }
  const die = causes.find((c) => c?._tag === "Die");
  if (die) {
    const defect = die.defect;
    return { error: new T3Error("die", str(obj(defect)?.message) ?? str(defect) ?? "T3 request died."), tag: null };
  }
  return { error: new T3Error("interrupt", "T3 interrupted the request."), tag: null };
}

// ---- Deep links (main:packages/shared/src/promptLinks.ts) ----

export function threadLinks(machine: Machine, threadId: string): { appUrl: string; webUrl: string | null } {
  const path = `${encodeURIComponent(machine.id)}/${encodeURIComponent(threadId)}`;
  return {
    appUrl: `t3code://threads/${path}`,
    webUrl: machine.webUrl ? `${machine.webUrl.replace(/\/+$/, "")}/${path}` : null,
  };
}

// ---- The link ----

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** A stream read for its first value only: interrupted once it arrives. */
  first?: boolean;
}

class Unauthorized extends Error {}

export function createLink(machine: Machine, token: string, events: LinkEvents, deps: LinkDeps = {}): T3Link & HostLink & WorkLink & FileLink {
  const WS = deps.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
  const fetchFn = deps.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${token}` };

  let state: LinkState = {
    status: "connecting",
    since: new Date().toISOString(),
    degraded: false,
    droppedRows: 0,
    unknownItems: 0,
    serverVersion: machine.serverVersion,
    message: null,
  };
  const shell = emptyShell();
  const counters: ShellCounters = { droppedRows: 0, unknownItems: 0 };
  const pending = new Map<string, Pending>();
  let ws: WsLike | null = null;
  let shellRequestId: string | null = null;
  let nextId = 0;
  let closed = false;
  let attempt = 0;
  let unansweredPings = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function setState(patch: Partial<LinkState>) {
    const next: LinkState = { ...state, ...patch };
    next.degraded = next.droppedRows > 0 || next.unknownItems > 0;
    const keys = Object.keys(next) as (keyof LinkState)[];
    if (keys.every((k) => k === "since" || next[k] === state[k])) return;
    if (next.status !== state.status) next.since = new Date().toISOString();
    state = next;
    if (!closed) events.onState(machine.id, state);
  }

  async function http(method: "GET" | "POST", path: string, headers: Record<string, string> = {}) {
    const res = await fetchFn(new URL(path, machine.apiUrl), {
      method,
      headers,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) throw new Unauthorized(`T3 rejected the token (HTTP ${res.status}).`);
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
      throw new T3Error("fail", `T3 answered HTTP ${res.status} for ${path.split("?")[0]}.`);
    }
    if (!res.ok) throw new Error(`T3 answered HTTP ${res.status}.`);
    return (await res.json()) as unknown;
  }

  /** HTTP for the public calls: a rejected token stops the link until the token is replaced. */
  async function authedHttp(path: string, headers: Record<string, string> = {}) {
    try {
      return await http("GET", path, { ...auth, ...headers });
    } catch (error) {
      if (error instanceof Unauthorized) {
        unauthorized(error.message);
        throw new T3Error("fail", error.message);
      }
      throw error;
    }
  }

  function schedule(ms: number) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void connect(), ms);
  }

  function teardown(reason: string) {
    clearInterval(pingTimer);
    const socket = ws;
    ws = null;
    shellRequestId = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close();
      } catch {}
    }
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  }

  function lost(message: string) {
    teardown(message);
    if (closed) return;
    setState({ status: "offline", message });
    // Jittered exponential backoff, 1 s → 5 min.
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt++);
    schedule(Math.round(ms * (0.5 + Math.random() / 2)));
  }

  function unauthorized(message: string) {
    teardown(message);
    clearTimeout(retryTimer);
    setState({ status: "unauthorized", message });
  }

  async function connect() {
    if (closed) return;
    counters.droppedRows = counters.unknownItems = 0;
    setState({ status: "connecting", message: null, droppedRows: 0, unknownItems: 0 });
    try {
      const desc = obj(await http("GET", "/.well-known/t3/environment"));
      if (closed) return;
      const serverVersion = str(desc?.serverVersion) ?? state.serverVersion;
      const protocol = desc?.orchestrationProtocolVersion;
      if (typeof protocol !== "number" || !SUPPORTED_PROTOCOLS.includes(protocol)) {
        setState({
          status: "incompatible",
          serverVersion,
          message: `T3 speaks orchestration protocol ${protocol ?? "unknown"}; the Command Center supports ${SUPPORTED_PROTOCOLS.join(", ")}.`,
        });
        return schedule(RECHECK_MS);
      }
      if (desc?.environmentId !== machine.id) {
        setState({ status: "incompatible", serverVersion, message: "This URL now serves a different T3 environment." });
        return schedule(RECHECK_MS);
      }
      setState({ serverVersion });
      const ticket = str(obj(await http("POST", "/api/auth/websocket-ticket", auth))?.ticket);
      if (closed) return;
      if (!ticket) throw new Error("T3 returned no WebSocket ticket.");
      open(ticket);
    } catch (error) {
      if (error instanceof Unauthorized) return unauthorized(error.message);
      lost(`Cannot reach T3: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function open(ticket: string) {
    const url = new URL("/ws", machine.apiUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("orchestrationProtocol", String(SUPPORTED_PROTOCOLS[0]));
    url.searchParams.set("wsTicket", ticket);
    const socket = new WS(url.toString());
    ws = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      unansweredPings = 0;
      pingTimer = setInterval(ping, PING_MS);
      // Re-subscribe on every connect: the first frame is authoritative, so there is no gap to fill.
      shellRequestId = String(++nextId);
      send({ _tag: "Request", id: shellRequestId, tag: "orchestration.subscribeShell", payload: {}, headers: [] });
    };
    socket.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      receive(data);
    };
    socket.onclose = socket.onerror = () => lost("T3 connection closed.");
  }

  function send(message: Json) {
    const data = JSON.stringify(message);
    deps.onFrame?.("out", data);
    ws?.send(data);
  }

  function ping() {
    if (unansweredPings >= 2) return lost("T3 stopped answering pings.");
    unansweredPings++;
    send({ _tag: "Ping" });
  }

  function receive(data: string) {
    deps.onFrame?.("in", data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      setState({ unknownItems: ++counters.unknownItems });
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!ws) return;
      handle(obj(message) ?? {});
    }
  }

  function handle(m: Json) {
    switch (m._tag) {
      case "Pong":
        unansweredPings = 0;
        return;
      case "Chunk": {
        // Effect RPC holds the stream until each chunk is acknowledged.
        send({ _tag: "Ack", requestId: m.requestId });
        if (String(m.requestId) !== shellRequestId) {
          const id = String(m.requestId);
          const p = pending.get(id);
          if (!p?.first) return;
          pending.delete(id);
          clearTimeout(p.timer);
          send({ _tag: "Interrupt", requestId: id });
          p.resolve(arr(m.values)[0]);
          return;
        }
        let result: "authoritative" | "delta" | null = null;
        for (const value of arr(m.values)) {
          const applied = applyShellItem(machine.id, shell, value, counters);
          if (applied === "authoritative") result = applied;
          else result ??= applied;
        }
        if (result === "authoritative" && state.status !== "online") attempt = 0;
        setState({
          ...(result === "authoritative" ? { status: "online" as const, message: null } : {}),
          droppedRows: counters.droppedRows,
          unknownItems: counters.unknownItems,
        });
        if (result) {
          events.onShell(machine.id, {
            projects: [...shell.projects.values()],
            threads: [...shell.threads.values()],
            authoritative: result === "authoritative",
          });
        }
        return;
      }
      case "Exit": {
        const id = String(m.requestId);
        const failure = exitFailure(m.exit);
        if (id === shellRequestId) {
          if (failure?.tag === "EnvironmentAuthorizationError") return unauthorized(failure.error.message);
          return lost(failure ? failure.error.message : "T3 ended the shell stream.");
        }
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        clearTimeout(p.timer);
        if (failure) p.reject(failure.error);
        else p.resolve(obj(m.exit)?.value);
        return;
      }
      case "Defect":
      case "ClientProtocolError":
        return lost("T3 reported a protocol error.");
    }
  }

  /** Unary call; with `first`, a stream call that resolves with its first value (undefined if it ends empty). */
  function rpc(tag: string, payload: unknown, first = false): Promise<unknown> {
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error("T3 link is not connected."));
    const id = String(++nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        send({ _tag: "Interrupt", requestId: id });
        reject(new Error(`T3 did not answer ${tag} within ${RPC_TIMEOUT_MS / 1000} s.`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer, first });
      send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  const dispatch = async (command: Json) => {
    await rpc("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
  };

  queueMicrotask(() => void connect());

  return {
    machineId: machine.id,
    get state() {
      return state;
    },
    async launch(input) {
      // Never reuseExistingThread (it means "adopt an existing empty thread") or creationSource.
      // A retry with the same commandId/threadId is idempotent through T3's command receipt.
      await rpc("orchestration.launchThread", {
        commandId: input.commandId,
        threadId: input.threadId,
        projectId: input.projectId,
        title: input.title.trim() || "Command Center task",
        generateTitle: false,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        workspaceStrategy: input.workspaceStrategy,
        initialMessage: { text: input.prompt, attachments: [] },
      });
    },
    interrupt: (threadId, runId) => dispatch({ type: "run.interrupt", threadId, runId }),
    respond: (threadId, requestId, decision: ApprovalDecision) =>
      dispatch({ type: "runtime-request.respond", threadId, requestId, decision }),
    settle: (threadId) => dispatch({ type: "thread.settle", threadId }),
    async providers() {
      const config = obj(await rpc("server.getConfig", {}));
      return arr(config?.providers).flatMap((raw): ProviderInfo[] => {
        const p = obj(raw);
        const instanceId = str(p?.instanceId);
        if (!p || !instanceId) return [];
        return [
          {
            instanceId,
            driver: str(p.driver) ?? "",
            displayName: str(p.displayName) ?? str(p.driver) ?? instanceId,
            enabled: p.enabled === true,
            installed: p.installed === true,
            models: arr(p.models).flatMap((rawModel) => {
              const m = obj(rawModel);
              const slug = str(m?.slug);
              return slug ? [{ slug, name: str(m?.name) ?? slug, isDefault: m?.isDefault === true }] : [];
            }),
          },
        ];
      });
    },
    hostResources: async () => toHostResources(await rpc("server.getHostResources", {})),
    // includeRemote: false keeps T3 from starting its fetch/auto-pull poller for this cwd.
    vcsStatus: async (cwd) => toVcsStatus(await rpc("subscribeVcsStatus", { cwd, includeRemote: false }, true)),
    async mergedPullRequests(projectIds) {
      const result = obj(await rpc("pullRequests.list", { state: "merged", projectIds: projectIds.slice(0, 100), limit: 50 }));
      return arr(result?.entries).flatMap((raw): MergedPr[] => {
        const e = obj(raw);
        const projectId = str(e?.projectId);
        const headBranch = str(e?.headBranch);
        const url = str(e?.url);
        return projectId && headBranch && url && typeof e?.number === "number" && e.state === "merged"
          ? [{ projectId, headBranch, number: e.number, url }]
          : [];
      });
    },
    async listEntries(cwd, directoryPath) {
      const result = obj(await rpc("projects.listEntries", { cwd, directoryPath }));
      return arr(result?.entries).flatMap((raw) => {
        const e = obj(raw);
        const path = str(e?.path);
        return path && (e?.kind === "file" || e?.kind === "directory") ? [{ path, kind: e.kind }] : [];
      });
    },
    async readFile(cwd, relativePath) {
      const result = obj(await rpc("projects.readFile", { cwd, relativePath }));
      return { contents: str(result?.contents) ?? "", truncated: result?.truncated === true };
    },
    async readResult(threadId): Promise<ThreadResult> {
      const body = obj(
        await authedHttp(`/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, {
          [PROTOCOL_HEADER]: String(SUPPORTED_PROTOCOLS[0]),
        }),
      );
      const projection = obj(body?.projection);
      const latest = (rows: unknown[]) =>
        rows.reduce<Json | null>((best, row) => {
          const r = obj(row);
          return r && (!best || String(r.createdAt) >= String(best.createdAt)) ? r : best;
        }, null);
      const message = latest(arr(projection?.messages).filter((m) => obj(m)?.role === "assistant"));
      const request = latest(arr(projection?.runtimeRequests).filter((r) => obj(r)?.status === "pending"));
      return {
        text: message ? (str(message.text) ?? "").slice(0, RESULT_MAX) : null,
        pending: request ? toPending(request, requestSummary(projection, String(request.id))) : null,
      };
    },
    async session(): Promise<SessionInfo> {
      const body = obj(await authedHttp("/api/auth/session"));
      if (body?.authenticated === false) {
        unauthorized("T3 no longer accepts the token.");
        throw new T3Error("fail", "T3 no longer accepts the token.");
      }
      return { expiresAt: str(body?.expiresAt), scopes: arr(body?.scopes).filter((s) => typeof s === "string") };
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      teardown("T3 link closed.");
    },
  };
}

/** The approval prompt or input questions for a pending request, from the bounded projection's turn items. */
function requestSummary(projection: Json | null, requestId: string): string | null {
  const items = [
    ...arr(projection?.turnItems),
    ...arr(projection?.visibleTurnItems).map((v) => obj(v)?.item),
  ];
  for (const raw of items) {
    const item = obj(raw);
    if (!item || item.requestId !== requestId) continue;
    if (item.type === "approval_request" && str(item.prompt)) return str(item.prompt)!.slice(0, SUMMARY_MAX);
    if (item.type === "user_input_request") {
      const questions = arr(item.questions).flatMap((q) => str(obj(q)?.question) ?? []);
      if (questions.length) return questions.join("\n").slice(0, SUMMARY_MAX);
    }
  }
  return null;
}

// ---- Contract needles ----

export interface ContractNeedle {
  /** Repo-relative path in pingdotgg/t3code. */
  file: string;
  /** Exact source text; whitespace runs compare as one space. */
  needle: string;
  why: string;
}

const C = "packages/contracts/src/";
const V2 = `${C}orchestrationV2.ts`;

export const T3_CONTRACT: ContractNeedle[] = [
  // Protocol, routes, wire
  { file: `${C}environment.ts`, needle: "export const ORCHESTRATION_PROTOCOL_VERSION = 2;", why: "SUPPORTED_PROTOCOLS = [2]" },
  { file: `${C}environment.ts`, needle: 'ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";', why: "/ws query parameter" },
  { file: `${C}environment.ts`, needle: 'ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";', why: "bounded snapshot header" },
  { file: `${C}environment.ts`, needle: "orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),", why: "descriptor protocol gate" },
  { file: `${C}environment.ts`, needle: "serverVersion: TrimmedNonEmptyString,", why: "descriptor serverVersion (version skew, contract canary)" },
  { file: `${C}environmentHttp.ts`, needle: '"/.well-known/t3/environment"', why: "descriptor route" },
  { file: `${C}environmentHttp.ts`, needle: '"/api/auth/websocket-ticket"', why: "WebSocket ticket route" },
  { file: `${C}environmentHttp.ts`, needle: '"/api/auth/session"', why: "token expiry and scopes" },
  { file: `${C}environmentHttp.ts`, needle: '"/api/orchestration/threads/:threadId/bounded"', why: "readResult route" },
  { file: `${C}auth.ts`, needle: "export const AuthWebSocketTicketResult = Schema.Struct({ ticket: TrimmedNonEmptyString,", why: "ticket response field" },
  { file: `${C}auth.ts`, needle: "scopes: Schema.optionalKey(AuthEnvironmentScopes),", why: "session() scopes" },
  { file: `${C}auth.ts`, needle: "expiresAt: Schema.optionalKey(Schema.DateTimeUtc), });", why: "session() expiresAt (end of AuthSessionState)" },
  { file: `${C}auth.ts`, needle: 'export class EnvironmentAuthorizationError extends Schema.TaggedError<EnvironmentAuthorizationError>()( "EnvironmentAuthorizationError",', why: "missing scope on subscribe → unauthorized" },
  { file: "apps/server/src/auth/EnvironmentAuth.ts", needle: 'const WEBSOCKET_TICKET_QUERY_PARAM = "wsTicket";', why: "/ws ticket query parameter" },
  { file: "apps/server/src/ws.ts", needle: "Layer.provideMerge(RpcSerialization.layerJson),", why: "Effect RPC JSON, one message per frame" },
  { file: "apps/server/src/ws.ts", needle: "{ status: 426 },", why: "protocol mismatch on /ws" },
  // Methods
  { file: V2, needle: 'subscribeShell: "orchestration.subscribeShell",', why: "live shell stream" },
  { file: V2, needle: 'launchThread: "orchestration.launchThread",', why: "launch" },
  { file: V2, needle: 'dispatchCommand: "orchestration.dispatchCommand",', why: "respond/interrupt/settle" },
  { file: `${C}rpc.ts`, needle: 'serverGetConfig: "server.getConfig",', why: "providers()" },
  { file: `${C}rpc.ts`, needle: 'serverGetHostResources: "server.getHostResources",', why: "hostResources()" },
  {
    file: "apps/server/src/auth/RpcAuthorization.ts",
    needle: "[WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,",
    why: "hostResources() needs only orchestration:read",
  },
  {
    file: `${C}resourceTelemetry.ts`,
    needle:
      "export const HostResourcesSnapshot = Schema.Struct({ sampledAt: NonNegativeInt, cpuUtilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))), cpuCount: NonNegativeInt, availableMemoryBytes: NonNegativeInt, totalMemoryBytes: NonNegativeInt, });",
    why: "HostResources fields (sampledAt in epoch ms)",
  },
  // Launch input
  {
    file: V2,
    needle:
      "export const OrchestrationV2ThreadLaunchInput = Schema.Struct({ commandId: CommandId, creationSource: Schema.optional(OrchestrationV2CreationSource), threadId: Schema.optional(ThreadId), reuseExistingThread: Schema.optional(Schema.Boolean), projectId: ProjectId, title: TrimmedNonEmptyString, generateTitle: Schema.optional(Schema.Boolean), modelSelection: ModelSelection, runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode, workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy, initialMessage: Schema.optional( Schema.Struct({ messageId: Schema.optional(MessageId), text: Schema.String,",
    why: "launch payload field names",
  },
  { file: V2, needle: "attachments: Schema.Array(ChatAttachment), }), ), }); export type OrchestrationV2ThreadLaunchInput", why: "initialMessage.attachments is required" },
  {
    file: "apps/server/src/orchestration-v2/ThreadLaunchService.ts",
    needle: '"Only an empty active thread in the target project can change workspace during launch."',
    why: "reuseExistingThread means 'adopt an existing empty thread', so the CC never sends it",
  },
  { file: "apps/server/src/orchestration-v2/ThreadLaunchService.ts", needle: "const launchReceipt = yield* readReceipt(input, input.commandId);", why: "launch retries with the same commandId are idempotent" },
  {
    file: V2,
    needle:
      'export const OrchestrationV2ThreadLaunchWorkspaceStrategy = Schema.Union([ Schema.Struct({ type: Schema.Literal("root"), branch: Schema.optional(TrimmedNonEmptyString), }), Schema.Struct({ type: Schema.Literal("existing_worktree"), worktreePath: TrimmedNonEmptyString, branch: Schema.optional(TrimmedNonEmptyString), }), Schema.Struct({ type: Schema.Literal("worktree"), baseRef: TrimmedNonEmptyString, branch: Schema.optional(TrimmedNonEmptyString), startFromOrigin: Schema.optional(Schema.Boolean), }), ]);',
    why: "WorkspaceStrategy in types.ts",
  },
  // Shell stream
  {
    file: V2,
    needle:
      'export const OrchestrationV2RunStatus = Schema.Literals([ "preparing", "queued", "starting", "running", "waiting", "completed", "interrupted", "failed", "cancelled", "rolled_back", ]);',
    why: "ThreadStatus in types.ts and the dispatcher's status mapping",
  },
  { file: V2, needle: 'kind: Schema.Literal("synchronized"),', why: "shell item kinds" },
  { file: V2, needle: "resolvedRepositoryIdentityRoots: Schema.optionalKey(Schema.Array(Schema.String)),", why: "enrichment snapshots never replace threads" },
  { file: V2, needle: 'kind: Schema.Literal("project.updated"), sequence: NonNegativeInt, project: OrchestrationProjectShell,', why: "shell item kinds" },
  { file: V2, needle: 'kind: Schema.Literal("project.removed"), sequence: NonNegativeInt, projectId: ProjectId,', why: "shell item kinds" },
  {
    file: V2,
    needle: 'kind: Schema.Literal("thread.updated"), sequence: NonNegativeInt, location: Schema.Literals(["active", "archive"]), thread: OrchestrationV2ThreadShell,',
    why: "archive location removes the live thread",
  },
  { file: V2, needle: 'kind: Schema.Literal("thread.removed"), sequence: NonNegativeInt, location: Schema.Literals(["active", "archive"]), threadId: ThreadId,', why: "shell item kinds" },
  { file: V2, needle: "snapshotSequence: NonNegativeInt, threads: Schema.Array(OrchestrationV2ThreadShell),", why: "authoritative snapshot shape" },
  { file: `${C}orchestrationProject.ts`, needle: "workspaceRoot: TrimmedNonEmptyString,", why: "ProjectRow.workspaceRoot" },
  { file: `${C}orchestrationProject.ts`, needle: "defaultModelSelection: Schema.NullOr(ModelSelection),", why: "ProjectRow.defaultModel" },
  // ThreadShell fields
  { file: V2, needle: "export const OrchestrationV2ThreadShell = Schema.Struct({ ...OrchestrationV2CreationFields, id: ThreadId, projectId: ProjectId, title: Schema.String, providerInstanceId: ProviderInstanceId,", why: "ThreadRow id/projectId/title/providerInstanceId" },
  { file: V2, needle: 'relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),', why: "top-level filter (lineage.relationshipToParent)" },
  { file: V2, needle: "latestRunCompletedAt: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)), activeRunId: Schema.NullOr(RunId),", why: "ThreadRow.completedAt/activeRunId" },
  { file: V2, needle: 'activityRunStatus: Schema.optional( Schema.NullOr(Schema.Literals(["preparing", "starting", "running", "waiting"])), ), status: OrchestrationV2ShellThreadStatus, lastError: Schema.optional(Schema.NullOr(Schema.String)),', why: "ThreadRow status fields" },
  { file: V2, needle: "usageLimitResetAt: Schema.optional(Schema.NullOr(IsoDateTime)), pendingRuntimeRequest: Schema.NullOr(OrchestrationV2PendingRuntimeRequestSummary),", why: "usage limit wait and needs-you" },
  { file: V2, needle: "hasActionableProposedPlan: Schema.Boolean,", why: "plan ready" },
  { file: V2, needle: "settledAt: Schema.NullOr(Schema.DateTimeUtc),", why: "ThreadRow.settledAt" },
  { file: V2, needle: "snoozedUntil: Schema.optional(Schema.NullOr(Schema.DateTimeUtc)),", why: "snoozed threads are hidden" },
  {
    file: V2,
    needle: "export const OrchestrationV2PendingRuntimeRequestSummary = Schema.Struct({ id: RuntimeRequestId, kind: OrchestrationV2RuntimeRequest.fields.kind, createdAt: Schema.DateTimeUtc, });",
    why: "PendingRequest shape",
  },
  { file: V2, needle: 'Schema.Literals(["dynamic_tool_call", "user_input", "auth_refresh"]),', why: "RequestKind in types.ts" },
  // Commands
  {
    file: V2,
    needle: 'type: Schema.Literal("runtime-request.respond"), commandId: CommandId, threadId: ThreadId, requestId: RuntimeRequestId, decision: Schema.optional(ProviderApprovalDecision),',
    why: "respond()",
  },
  { file: V2, needle: 'type: Schema.Literal("run.interrupt"), commandId: CommandId, threadId: ThreadId, runId: RunId,', why: "interrupt()" },
  { file: V2, needle: 'type: Schema.Literal("thread.settle"), commandId: CommandId, threadId: ThreadId,', why: "settle()" },
  { file: `${C}providerPolicy.ts`, needle: 'export const ProviderApprovalDecision = Schema.Literals([ "accept", "acceptForSession",', why: "ApprovalDecision accept/acceptForSession" },
  { file: `${C}providerPolicy.ts`, needle: '"decline",', why: "ApprovalDecision decline" },
  // readResult (bounded projection)
  { file: V2, needle: "runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest), messages: Schema.Array(OrchestrationV2ConversationMessage),", why: "readResult reads messages and runtime requests" },
  { file: V2, needle: 'role: Schema.Literals(["user", "assistant", "system"]), text: Schema.String,', why: "last assistant message text" },
  { file: V2, needle: 'status: Schema.Literals(["pending", "resolved", "expired", "cancelled"]),', why: "pending runtime request" },
  { file: V2, needle: 'type: Schema.Literal("approval_request"), requestId: RuntimeRequestId, requestKind: ProviderRequestKind, prompt: Schema.optional(Schema.String),', why: "pending request summary" },
  { file: V2, needle: 'type: Schema.Literal("user_input_request"), requestId: RuntimeRequestId, questions: Schema.Array(OrchestrationV2UserInputQuestion),', why: "pending input summary" },
  // providers()
  { file: `${C}server.ts`, needle: "providers: ServerProviders,", why: "server.getConfig providers" },
  { file: `${C}server.ts`, needle: "export const ServerProvider = Schema.Struct({", why: "ProviderInfo" },
  { file: `${C}server.ts`, needle: "instanceId: ProviderInstanceId,", why: "ProviderInfo.instanceId" },
  { file: `${C}server.ts`, needle: "enabled: Schema.Boolean, installed: Schema.Boolean,", why: "ProviderInfo enabled/installed" },
  { file: `${C}server.ts`, needle: "models: Schema.Array(ServerProviderModel),", why: "ProviderInfo.models" },
  { file: `${C}server.ts`, needle: "slug: TrimmedNonEmptyString, name: TrimmedNonEmptyString,", why: "ProviderModel slug/name" },
  { file: `${C}server.ts`, needle: "isDefault: Schema.optional(Schema.Boolean),", why: "ProviderModel.isDefault" },
  // Work view: branch fields, passive VCS status, merged PRs (all orchestration:read)
  { file: V2, needle: "interactionMode: ProviderInteractionMode, branch: Schema.NullOr(TrimmedNonEmptyString), worktreePath: Schema.NullOr(TrimmedNonEmptyString),", why: "WorkFields branch/worktreePath" },
  { file: V2, needle: "linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)), pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),", why: "WorkFields.pr from shell PR links" },
  { file: V2, needle: "branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),", why: "WorkFields.pr fallback" },
  { file: `${C}threadPullRequest.ts`, needle: "export const ThreadLinkedPullRequest = Schema.Struct({ projectId: ProjectId, repository: TrimmedNonEmptyString, number: PositiveInt, url: TrimmedNonEmptyString, });", why: "linked/branch PR number and url" },
  { file: `${C}threadPullRequest.ts`, needle: '"stack-dismissed", ]);', why: "dismissed stack links are hidden" },
  { file: `${C}threadPullRequest.ts`, needle: "url: TrimmedNonEmptyString, source: ThreadPullRequestLinkSource, linkedAt: IsoDateTime, snapshot: Schema.NullOr(ThreadPullRequestSnapshot),", why: "PR link fields" },
  { file: `${C}threadPullRequest.ts`, needle: "state: PullRequestState, title: TrimmedNonEmptyString, headBranch: TrimmedNonEmptyString, baseBranch: TrimmedNonEmptyString, isDraft: Schema.Boolean, updatedAt: Schema.NullOr(IsoDateTime), syncedAt: IsoDateTime,", why: "PR link snapshot fields" },
  { file: `${C}pullRequest.ts`, needle: 'export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);', why: "WorkPr.state" },
  { file: `${C}rpc.ts`, needle: 'subscribeVcsStatus: "subscribeVcsStatus",', why: "vcsStatus()" },
  { file: "apps/server/src/auth/RpcAuthorization.ts", needle: "[WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,", why: "vcsStatus() needs only orchestration:read" },
  { file: `${C}git.ts`, needle: "includeRemote: Schema.optional(Schema.Boolean),", why: "vcsStatus() sends includeRemote: false" },
  {
    file: "apps/server/src/vcs/VcsStatusBroadcaster.ts",
    needle: "if (input.includeRemote !== false) { yield* retainRemotePoller(",
    why: "includeRemote: false never starts the fetch/auto-pull poller, so the read stays passive",
  },
  { file: `${C}git.ts`, needle: 'Schema.TaggedStruct("snapshot", { local: VcsStatusLocalResult, remote: Schema.NullOr(VcsStatusRemoteResult), }),', why: "the first stream value is a snapshot" },
  {
    file: `${C}git.ts`,
    needle: "isRepo: Schema.Boolean, sourceControlProvider: Schema.optional(SourceControlProviderInfo), hasPrimaryRemote: Schema.Boolean, isDefaultRef: Schema.Boolean, refName: Schema.NullOr(TrimmedNonEmptyStringSchema), hasWorkingTreeChanges: Schema.Boolean, workingTree: Schema.Struct({ files: Schema.Array(",
    why: "VcsStatus local fields",
  },
  { file: `${C}git.ts`, needle: "hasUpstream: Schema.Boolean, aheadCount: NonNegativeInt, behindCount: NonNegativeInt, aheadOfDefaultCount: Schema.optional(NonNegativeInt), pr: Schema.NullOr(VcsStatusChangeRequest),", why: "VcsStatus remote fields" },
  { file: `${C}git.ts`, needle: "number: PositiveInt, title: TrimmedNonEmptyStringSchema, url: Schema.String, baseRef: TrimmedNonEmptyStringSchema, headRef: TrimmedNonEmptyStringSchema, state: VcsStatusChangeRequestState,", why: "VcsStatus remote pr" },
  { file: `${C}rpc.ts`, needle: 'pullRequestsList: "pullRequests.list",', why: "mergedPullRequests()" },
  { file: "apps/server/src/auth/RpcAuthorization.ts", needle: "[WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,", why: "mergedPullRequests() needs only orchestration:read" },
  { file: `${C}pullRequest.ts`, needle: 'export const PullRequestListState = Schema.Literals(["all", "open", "closed", "merged"]);', why: "state: merged" },
  { file: `${C}pullRequest.ts`, needle: "projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),", why: "projectIds capped at 100" },
  { file: `${C}pullRequest.ts`, needle: "limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),", why: "limit 50" },
  {
    file: `${C}pullRequest.ts`,
    needle: "projectId: ProjectId, projectTitle: TrimmedNonEmptyString, repository: TrimmedNonEmptyString, number: PositiveInt, title: TrimmedNonEmptyString, url: TrimmedNonEmptyString, author: Schema.NullOr(PullRequestActor), headBranch: TrimmedNonEmptyString, baseBranch: TrimmedNonEmptyString, state: PullRequestState,",
    why: "MergedPr fields",
  },
  { file: `${C}pullRequest.ts`, needle: "entries: Schema.Array(PullRequestListEntry),", why: "pullRequests.list entries" },
  // Workflow import: workspace file reads (filesystem:read)
  { file: `${C}rpc.ts`, needle: 'projectsListEntries: "projects.listEntries",', why: "listEntries()" },
  { file: `${C}rpc.ts`, needle: 'projectsReadFile: "projects.readFile",', why: "readFile()" },
  { file: "apps/server/src/auth/RpcAuthorization.ts", needle: "[WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,", why: "listEntries() needs filesystem:read" },
  { file: "apps/server/src/auth/RpcAuthorization.ts", needle: "[WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,", why: "readFile() needs filesystem:read" },
  { file: `${C}auth.ts`, needle: 'export const AuthFilesystemReadScope = "filesystem:read" as const;', why: "scope name in the token docs" },
  { file: `${C}project.ts`, needle: 'export const ProjectEntryKind = Schema.Literals(["file", "directory"]);', why: "listEntries() kinds" },
  { file: `${C}project.ts`, needle: "export const ProjectEntry = Schema.Struct({ path: TrimmedNonEmptyString, kind: ProjectEntryKind,", why: "listEntries() entry fields" },
  { file: `${C}project.ts`, needle: "export const ProjectListEntriesInput = Schema.Struct({ cwd: TrimmedNonEmptyString,", why: "listEntries() cwd" },
  { file: `${C}project.ts`, needle: "directoryPath: Schema.optional(TrimmedString), });", why: "listEntries() lists one directory's children" },
  { file: `${C}project.ts`, needle: "export const ProjectListEntriesResult = Schema.Struct({ entries: Schema.Array(ProjectEntry), truncated: Schema.Boolean, });", why: "listEntries() result" },
  { file: `${C}project.ts`, needle: "export const ProjectReadFileInput = Schema.Struct({ cwd: TrimmedNonEmptyString,", why: "readFile() cwd" },
  { file: `${C}project.ts`, needle: "relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)), });", why: "readFile() relativePath" },
  { file: `${C}project.ts`, needle: "relativePath: TrimmedNonEmptyString, contents: Schema.String, byteLength: NonNegativeInt, truncated: Schema.Boolean, });", why: "readFile() result" },
  // Deep links
  { file: "packages/shared/src/promptLinks.ts", needle: "t3code://threads/<environmentId>/<threadId>", why: "threadLinks appUrl" },
  { file: "packages/shared/src/promptLinks.ts", needle: "https://app.t3.codes/<environmentId>/<threadId>", why: "threadLinks webUrl" },
];

const squash = (s: string) => s.replace(/\s+/g, " ");

/** Needles whose file is missing or no longer contains them. `read` returns null for a missing file. */
export async function checkContract(read: (file: string) => Promise<string | null>): Promise<ContractNeedle[]> {
  const files = new Map<string, Promise<string | null>>();
  const misses: ContractNeedle[] = [];
  for (const n of T3_CONTRACT) {
    let text = files.get(n.file);
    if (!text) files.set(n.file, (text = read(n.file).then((t) => (t === null ? null : squash(t)))));
    const t = await text;
    if (t === null || !t.includes(squash(n.needle))) misses.push(n);
  }
  return misses;
}

/** Reads upstream files at a ref (branch or tag such as "v0.3.1"). Network errors throw; 404 is a missing file. */
export function githubReader(ref: string, fetchImpl: typeof fetch = fetch) {
  return async (file: string): Promise<string | null> => {
    const res = await fetchImpl(
      `https://raw.githubusercontent.com/pingdotgg/t3code/${ref.split("/").map(encodeURIComponent).join("/")}/${file}`,
      { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for ${file}.`);
    return res.text();
  };
}
