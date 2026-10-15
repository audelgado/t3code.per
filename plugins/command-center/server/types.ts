// Shared CC types: domain, the T3Link seam, and the HTTP API contract.
// The web imports this file type-only. Timestamps are ISO-8601 strings.

// ---- T3 wire literals the CC uses (mirrors main:packages/contracts) ----

export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";
export type InteractionMode = "default" | "plan";
/** Shell thread status: "idle" plus OrchestrationV2RunStatus. */
export type ThreadStatus =
  | "idle"
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";
export type ActivityRunStatus = "preparing" | "starting" | "running" | "waiting";
/** ProviderRequestKind plus the runtime-only kinds. Unknown future kinds pass through as strings. */
export type RequestKind =
  | "command"
  | "file-read"
  | "file-change"
  | "mcp-elicitation"
  | "permission"
  | "dynamic_tool_call"
  | "user_input"
  | "auth_refresh"
  | (string & {});
/** The subset of ProviderApprovalDecision the CC sends. */
export type ApprovalDecision = "accept" | "acceptForSession" | "decline";

export interface ModelSelection {
  instanceId: string;
  model: string;
  options?: unknown;
}

/** OrchestrationV2ThreadLaunchWorkspaceStrategy. */
export type WorkspaceStrategy =
  | { type: "root"; branch?: string }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean }
  | { type: "existing_worktree"; worktreePath: string; branch?: string };

// ---- Machines and links ----

/** One T3 environment. id = the environment's environmentId. The bearer token is never part of it. */
export interface Machine {
  id: string;
  label: string;
  apiUrl: string;
  webUrl: string | null;
  maxConcurrent: number;
  enabled: boolean;
  serverVersion: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
}

export type LinkStatus = "connecting" | "online" | "offline" | "incompatible" | "unauthorized";

export interface LinkState {
  status: LinkStatus;
  since: string;
  /** True once any row was dropped or any stream item was unknown since connect. */
  degraded: boolean;
  droppedRows: number;
  unknownItems: number;
  /** From the environment descriptor; null until first fetched. */
  serverVersion: string | null;
  /** Short human reason for offline/incompatible/unauthorized. Never contains a token. */
  message: string | null;
}

export interface ProjectRow {
  machineId: string;
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModel: ModelSelection | null;
  updatedAt: string;
}

export interface PendingRequest {
  id: string;
  kind: RequestKind;
  /** Shell rows carry no summary; readResult fills it when the bounded thread has one. */
  summary: string | null;
  createdAt: string;
}

export interface ThreadRow {
  machineId: string;
  id: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  activityRunStatus: ActivityRunStatus | null;
  activeRunId: string | null;
  pendingRequest: PendingRequest | null;
  hasActionableProposedPlan: boolean;
  lastError: string | null;
  usageLimitResetAt: string | null;
  relationshipToParent: "fork" | "subagent" | null;
  snoozedUntil: string | null;
  settledAt: string | null;
  providerInstanceId: string;
  /** latestRunCompletedAt. */
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One onShell emission: the machine's full live rows after applying a stream item. */
export interface ShellUpdate {
  projects: ProjectRow[];
  threads: ThreadRow[];
  /** True when produced by an authoritative snapshot (a missing thread really is gone). */
  authoritative: boolean;
}

export interface LinkEvents {
  onShell(machineId: string, shell: ShellUpdate): void;
  onState(machineId: string, state: LinkState): void;
}

export interface LaunchInput {
  commandId: string;
  threadId: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  workspaceStrategy: WorkspaceStrategy;
  prompt: string;
}

export interface ProviderModel {
  slug: string;
  name: string;
  isDefault: boolean;
}

export interface ProviderInfo {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  installed: boolean;
  models: ProviderModel[];
}

export interface ThreadResult {
  /** Last assistant text, ≤4000 chars. */
  text: string | null;
  pending: PendingRequest | null;
}

export interface SessionInfo {
  expiresAt: string | null;
  scopes: string[];
}

/**
 * The only seam to T3 (implemented by server/t3link.ts, faked in tests).
 * Calls reject with T3Error when T3 answered with an Exit failure; any other rejection
 * is a transport problem and may be retried with the same ids.
 */
export interface T3Link {
  readonly machineId: string;
  readonly state: LinkState;
  launch(input: LaunchInput): Promise<void>;
  interrupt(threadId: string, runId: string): Promise<void>;
  respond(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  settle(threadId: string): Promise<void>;
  providers(): Promise<ProviderInfo[]>;
  readResult(threadId: string): Promise<ThreadResult>;
  session(): Promise<SessionInfo>;
  close(): void;
}

export type LinkFactory = (machine: Machine, token: string, events: LinkEvents) => T3Link;

/** T3 answered with an Exit failure (the command was rejected; retrying the same ids will not help). */
export class T3Error extends Error {
  readonly kind: "fail" | "die" | "interrupt";
  constructor(kind: "fail" | "die" | "interrupt", message: string) {
    super(message);
    this.name = "T3Error";
    this.kind = kind;
  }
}

// ---- Tasks ----

export type TaskStatus =
  | "pending_approval"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "needs_you"
  | "done"
  | "failed"
  | "cancelled";

/** "user" from the PWA; "agent:<label>" from the CC MCP (always needs approval). */
export type TaskSource = "user" | `agent:${string}`;

export interface Task {
  id: string;
  title: string;
  prompt: string;
  machineId: string;
  projectId: string;
  /** null = project default, then the first enabled provider's default. */
  model: ModelSelection | null;
  /** null only while an agent task awaits approval. */
  runtimeMode: RuntimeMode | null;
  interactionMode: InteractionMode;
  workspace: WorkspaceStrategy;
  /** -2..2, higher dispatches first. */
  priority: number;
  dependsOn: string[];
  source: TaskSource;
  status: TaskStatus;
  commandId: string | null;
  threadId: string | null;
  threadSeenAt: string | null;
  limitResetAt: string | null;
  error: string | null;
  /** Final assistant text, ≤4000 chars. */
  result: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** POST /api/tasks body. */
export interface TaskInput {
  prompt: string;
  title?: string;
  machineId: string;
  projectId: string;
  model?: ModelSelection | null;
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  workspace?: WorkspaceStrategy;
  priority?: number;
  dependsOn?: string[];
}

// ---- HomeView ----

export type AlertKind =
  | "offline"
  | "incompatible"
  | "unauthorized"
  | "token_expiring"
  | "degraded"
  | "provider_paused"
  | "version_skew"
  | "contract_break";

export interface Alert {
  /** Stable identity, e.g. "offline:<machineId>"; used for dedupe and notification tags. */
  key: string;
  kind: AlertKind;
  machineId: string | null;
  message: string;
  since: string;
}

export interface MachineView extends Machine {
  link: LinkState;
  /** CC tasks in starting|running|needs_you. */
  running: number;
  queued: number;
}

export interface ThreadItem {
  /** "<machineId>:<threadId>". */
  key: string;
  machineId: string;
  threadId: string;
  projectId: string;
  title: string;
  status: ThreadStatus;
  /** Set when this thread was launched by a CC task. */
  taskId: string | null;
  pending: PendingRequest | null;
  planReady: boolean;
  /** usageLimitResetAt when the thread waits on a usage limit. */
  waitingUntil: string | null;
  /** Done list: ≤200 chars of the result. */
  preview: string | null;
  failed: boolean;
  updatedAt: string;
  /** t3code://threads/<env>/<thread>. */
  appUrl: string;
  /** <webUrl>/<env>/<thread>, null when the machine has no web URL. */
  webUrl: string | null;
}

export interface TaskItem extends Task {
  machineLabel: string;
  projectTitle: string;
  /** Ids of dependencies that are not done yet. */
  blockedBy: string[];
}

export type NeedsYouItem =
  | { kind: "thread"; reason: "approval" | "input" | "plan"; since: string; thread: ThreadItem }
  | { kind: "task_approval"; since: string; task: TaskItem }
  /** A workflow run waiting on you (approval, ask or manual gate); key "workflow:<runId>:<nodeId|approval>". */
  | { kind: "workflow"; key: string; since: string; runId: string; title: string; text: string }
  | { kind: "alert"; since: string; alert: Alert };

export interface HomeView {
  machines: MachineView[];
  needsYou: NeedsYouItem[];
  running: ThreadItem[];
  done: ThreadItem[];
  queue: TaskItem[];
}

// ---- HTTP API contract ----

export interface ApiError {
  error: { code: string; message: string };
}

export interface MachineProjects {
  machineId: string;
  machineLabel: string;
  status: LinkStatus;
  projects: ProjectRow[];
}

export interface Ok {
  ok: true;
}

/**
 * Every route as "METHOD path" (":name" = path param) with its body and response.
 * GET /api/events is SSE: each `data:` frame is a full HomeView.
 */
export interface Api {
  "GET /healthz": { body: never; res: { ok: true; activeRuns: Record<string, number> } };
  "POST /api/pair": { body: { token: string }; res: Ok };
  "POST /api/logout": { body: never; res: Ok };
  "GET /api/view": { body: never; res: HomeView };
  "GET /api/events": { body: never; res: HomeView };
  "GET /api/projects": { body: never; res: MachineProjects[] };
  "POST /api/tasks": { body: TaskInput; res: Task };
  "GET /api/tasks/:id": { body: never; res: Task };
  "PATCH /api/tasks/:id": { body: { priority: number }; res: Task };
  "POST /api/tasks/:id/cancel": { body: never; res: Task };
  "POST /api/tasks/:id/retry": { body: never; res: Task };
  /** runtimeMode is required for agent tasks. */
  "POST /api/tasks/:id/approve": { body: { runtimeMode?: RuntimeMode }; res: Task };
  "POST /api/tasks/:id/reject": { body: never; res: Task };
  "GET /api/machines": { body: never; res: MachineView[] };
  "GET /api/machines/:id/providers": { body: never; res: ProviderInfo[] };
}
export type ApiRoute = keyof Api;
