// Pure HomeView builder. Every list has a total order, so identical input gives an identical hash.
import { createHash } from "node:crypto";
import type {
  Alert,
  HomeView,
  LinkState,
  Machine,
  MachineView,
  NeedsYouItem,
  ProjectRow,
  Task,
  TaskItem,
  ThreadItem,
  ThreadRow,
  ThreadStatus,
} from "./types.ts";
import type { WorkflowNeed } from "./workflows.ts";

/** A provider instance on one machine hit a usage limit; the dispatcher holds its tasks until `until`. */
export interface ProviderPause {
  machineId: string;
  instanceId: string;
  since: string;
  until: string;
}

export interface ViewInput {
  machines: Machine[];
  linkStates: Record<string, LinkState>;
  projects: ProjectRow[];
  threads: ThreadRow[];
  tasks: Task[];
  pauses?: ProviderPause[];
  extraAlerts?: Alert[];
  workflowNeeds?: WorkflowNeed[];
  /** Deep links into T3 (from server/t3link.ts, the only file that knows T3's URL shapes). */
  threadLinks: (machine: Machine, threadId: string) => { appUrl: string; webUrl: string | null };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ACTIVE_RUN = new Set<ThreadStatus>(["preparing", "queued", "starting", "running", "waiting"]);
const INPUT_KINDS = new Set(["user_input", "mcp-elicitation"]);

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const asc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Snoozed threads stay hidden until the wake time passes or they raise a hand. Malformed times never hide. */
const snoozed = (row: ThreadRow, now: number) =>
  row.snoozedUntil !== null && Date.parse(row.snoozedUntil) > now && row.pendingRequest === null;

/**
 * T3's own recovery-candidate rule: a failed run with a reset time (T3 never clears limitRecovery, so it is no signal).
 * 15 min past the reset with the run still failed means T3 will not resume it (autoResume off): stop waiting.
 */
export const usageLimitWaiting = (row: ThreadRow, now: number) =>
  row.status === "failed" && row.usageLimitResetAt !== null && Date.parse(row.usageLimitResetAt) + 15 * MINUTE > now;

/**
 * Numeric-aware compare of dotted versions.
 * ponytail: no semver prerelease rules ("1.2.0" sorts before "1.2.0-x"); use a semver parser if T3 ships prereleases to the VPS.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    if (x === y) continue;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

const DEFAULT_LINK: LinkState = {
  status: "connecting",
  since: "",
  degraded: false,
  droppedRows: 0,
  unknownItems: 0,
  serverVersion: null,
  message: null,
};

export function buildHomeView(input: ViewInput, now: number): HomeView {
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const linkOf = (id: string) => input.linkStates[id] ?? DEFAULT_LINK;
  const tasksById = new Map(input.tasks.map((t) => [t.id, t]));
  const taskByThread = new Map<string, Task>(input.tasks.flatMap((t) => (t.threadId ? [[`${t.machineId}:${t.threadId}`, t] as const] : [])));
  const projectTitles = new Map(input.projects.map((p) => [`${p.machineId}:${p.id}`, p.title]));

  const threadItem = (row: ThreadRow, machine: Machine, preview: boolean): ThreadItem => {
    const key = `${row.machineId}:${row.id}`;
    const task = taskByThread.get(key) ?? null;
    return {
      key,
      machineId: row.machineId,
      threadId: row.id,
      projectId: row.projectId,
      title: row.title,
      status: row.status,
      taskId: task?.id ?? null,
      pending: row.pendingRequest,
      planReady: row.hasActionableProposedPlan,
      waitingUntil: usageLimitWaiting(row, now) ? row.usageLimitResetAt : null,
      preview: preview ? (task?.result?.slice(0, 200) ?? null) : null,
      failed: row.status === "failed",
      updatedAt: row.updatedAt,
      ...input.threadLinks(machine, row.id),
    };
  };
  const taskItem = (task: Task): TaskItem => ({
    ...task,
    machineLabel: machines.get(task.machineId)?.label ?? task.machineId,
    projectTitle: projectTitles.get(`${task.machineId}:${task.projectId}`) ?? task.projectId,
    blockedBy: task.dependsOn.filter((id) => tasksById.get(id)?.status !== "done"),
  });

  const asks: { since: string; item: NeedsYouItem & { kind: "thread" } }[] = [];
  const plans: typeof asks = [];
  const running: { at: string; item: ThreadItem }[] = [];
  const done: { at: string; item: ThreadItem }[] = [];
  for (const row of input.threads) {
    const machine = machines.get(row.machineId);
    if (!machine || row.relationshipToParent === "subagent" || snoozed(row, now)) continue;
    const working = ACTIVE_RUN.has(row.status) || row.activeRunId !== null;
    if (row.pendingRequest) {
      const reason = INPUT_KINDS.has(row.pendingRequest.kind) ? "input" : "approval";
      const since = row.pendingRequest.createdAt;
      asks.push({ since, item: { kind: "thread", reason, since, thread: threadItem(row, machine, false) } });
    } else if (row.hasActionableProposedPlan && row.settledAt === null && !working) {
      const since = row.completedAt ?? row.updatedAt;
      plans.push({ since, item: { kind: "thread", reason: "plan", since, thread: threadItem(row, machine, false) } });
    } else if (working || usageLimitWaiting(row, now)) {
      running.push({ at: row.createdAt, item: threadItem(row, machine, false) });
    } else if ((row.status === "completed" || row.status === "failed") && row.completedAt) {
      const at = Date.parse(row.completedAt);
      if (at <= now && now - at <= DAY) done.push({ at: row.completedAt, item: threadItem(row, machine, true) });
    }
  }
  const bySince = (a: { since: string; item: { thread: ThreadItem } }, b: typeof a) =>
    asc(a.since, b.since) || byKey(a.item.thread, b.item.thread);
  asks.sort(bySince);
  plans.sort(bySince);
  // Newest first by createdAt (not updatedAt), so rows do not reshuffle while agents work.
  running.sort((a, b) => asc(b.at, a.at) || byKey(a.item, b.item));
  done.sort((a, b) => asc(b.at, a.at) || byKey(a.item, b.item));

  // ---- machines and alerts ----
  const count = (machineId: string, statuses: Task["status"][]) =>
    input.tasks.filter((t) => t.machineId === machineId && statuses.includes(t.status)).length;
  const versionOf = (m: Machine) => linkOf(m.id).serverVersion ?? m.serverVersion;
  const newest = input.machines
    .map(versionOf)
    .filter((v) => v !== null)
    .reduce<string | null>((a, b) => (a === null || compareVersions(b, a) > 0 ? b : a), null);

  const alerts: Alert[] = [];
  const alert = (kind: Alert["kind"], m: Machine, message: string, since: string) =>
    alerts.push({ key: `${kind}:${m.id}`, kind, machineId: m.id, message: `${m.label}: ${message}`, since });
  for (const m of input.machines) {
    if (!m.enabled) continue;
    const link = linkOf(m.id);
    const waiting = count(m.id, ["queued", "starting"]);
    if (link.status === "offline" && waiting > 0 && now - Date.parse(link.since) > 15 * MINUTE)
      alert("offline", m, `offline with ${waiting} task${waiting === 1 ? "" : "s"} waiting`, link.since);
    if (link.status === "incompatible") alert("incompatible", m, link.message ?? "T3 protocol not supported; dispatch paused", link.since);
    if (link.status === "unauthorized") alert("unauthorized", m, "token rejected; run `machine add` with a new token", link.since);
    if (m.tokenExpiresAt && Date.parse(m.tokenExpiresAt) - now <= 14 * DAY)
      alert("token_expiring", m, `T3 token expires ${m.tokenExpiresAt}`, m.tokenExpiresAt);
    if (link.degraded)
      alert("degraded", m, `T3 sent data the CC could not read (${link.droppedRows} rows dropped, ${link.unknownItems} unknown items)`, link.since);
    const version = versionOf(m);
    if (version && newest && compareVersions(version, newest) < 0)
      alert("version_skew", m, `T3 ${version} is behind ${newest}; update it`, link.since);
  }
  for (const p of input.pauses ?? []) {
    const m = machines.get(p.machineId);
    if (!m || Date.parse(p.until) <= now) continue;
    alerts.push({
      key: `provider_paused:${p.machineId}:${p.instanceId}`,
      kind: "provider_paused",
      machineId: p.machineId,
      message: `${m.label}: ${p.instanceId} hit a usage limit; paused until ${p.until}`,
      since: p.since,
    });
  }
  alerts.push(...(input.extraAlerts ?? []));
  alerts.sort((a, b) => asc(a.since, b.since) || byKey(a, b));

  const machineViews: MachineView[] = input.machines.map((m) => ({
    ...m,
    serverVersion: versionOf(m),
    link: linkOf(m.id),
    running: count(m.id, ["starting", "running", "needs_you"]),
    queued: count(m.id, ["queued"]),
  }));

  // Approvals first (they block on you), then dispatch order.
  const queueOrder = (a: Task, b: Task) =>
    Number(b.status === "pending_approval") - Number(a.status === "pending_approval") ||
    b.priority - a.priority ||
    asc(a.createdAt, b.createdAt) ||
    asc(a.id, b.id);
  const OPEN = new Set<Task["status"]>(["pending_approval", "queued", "starting", "running", "waiting", "needs_you"]);
  return {
    machines: machineViews,
    needsYou: [
      ...asks.map((a) => a.item),
      ...plans.map((p) => p.item),
      ...input.tasks
        .filter((t) => t.status === "pending_approval")
        .sort((a, b) => asc(a.createdAt, b.createdAt) || asc(a.id, b.id))
        .map((t): NeedsYouItem => ({ kind: "task_approval", since: t.createdAt, task: taskItem(t) })),
      ...(input.workflowNeeds ?? [])
        .map((n): NeedsYouItem & { kind: "workflow" } => ({
          kind: "workflow",
          key: `workflow:${n.runId}:${n.nodeId ?? "approval"}`,
          since: n.since,
          runId: n.runId,
          title: n.title,
          text: n.text,
        }))
        .sort((a, b) => asc(a.since, b.since) || byKey(a, b)),
      ...alerts.map((a): NeedsYouItem => ({ kind: "alert", since: a.since, alert: a })),
    ],
    running: running.slice(0, 50).map((r) => r.item),
    done: done.slice(0, 30).map((d) => d.item),
    // Every unfinished CC task, plus failures and cancellations of the last 24 h so Retry stays reachable.
    queue: input.tasks
      .filter(
        (t) =>
          OPEN.has(t.status) ||
          ((t.status === "failed" || t.status === "cancelled") && t.finishedAt !== null && now - Date.parse(t.finishedAt) <= DAY),
      )
      .sort(queueOrder)
      .map(taskItem),
  };
}

/** Stable short hash of a view; SSE sends a frame only when it changes. */
export const hashView = (view: HomeView) => createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 16);
