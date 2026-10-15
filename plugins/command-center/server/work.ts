// Work: read-only branch and PR lifecycle per project, grouped by machine. Reads T3 only while the
// Work screen asks; the CC never runs git writes. "Ask an agent to tidy" queues a normal user task.
// Wire-up: `routes.push(...createWork({ machines: () => view().machines, projects: () => listProjects(db),
//   threads: () => dispatcher.threads(), tasks: () => listTasks(db), link: (id) => links.get(id)?.link,
//   createTask: (input) => dispatcher.createTask(input, "user") }).routes)`.
import { TaskError } from "./dispatcher.ts";
import { HttpError, type Route } from "./http.ts";
import { threadLinks, type MergedPr, type VcsStatus, type WorkFields, type WorkLink, type WorkPr } from "./t3link.ts";
import type { LinkStatus, MachineView, ProjectRow, T3Link, Task, TaskInput, ThreadRow } from "./types.ts";

/** At most one T3 read per checkout (and one PR list per machine) per window. */
export const FRESH_MS = 30_000;
/** Status reads per refresh; older checkouts show "not read". */
export const STATUS_CAP = 20;
/** A slow machine never holds the screen longer than this; its reads land in the cache for the next poll. */
const WAIT_MS = 5_000;
const STALE_MS = 14 * 86_400_000;
const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export const STAGES = ["Created", "Working", "Committed", "Pushed", "PR open", "Merged", "Cleanup"] as const;

type Row = ThreadRow & Partial<WorkFields>;
type Agent = "working" | "needs-you" | "idle";

/** One branch or worktree: every top-level thread on the same machine, project and checkout. */
export interface WorkItem {
  key: string;
  machineId: string;
  projectId: string;
  branch: string;
  worktreePath: string | null;
  cwd: string;
  /** Newest first. */
  threadIds: string[];
  title: string;
  taskId: string | null;
  agent: Agent;
  pr: WorkPr | null;
  updatedAt: string;
}

/** Each machine and project owns its work, even when repository remotes match. */
export function deriveWorkItems(threads: Row[], projects: ProjectRow[], tasks: Pick<Task, "id" | "machineId" | "threadId">[]): WorkItem[] {
  const roots = new Map(projects.map((p) => [`${p.machineId}\0${p.id}`, p.workspaceRoot]));
  const taskOf = new Map(tasks.flatMap((t) => (t.threadId ? [[`${t.machineId}\0${t.threadId}`, t.id] as const] : [])));
  const items = new Map<string, WorkItem>();
  for (const t of [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const root = roots.get(`${t.machineId}\0${t.projectId}`);
    if (!t.branch || t.relationshipToParent === "subagent" || root === undefined) continue;
    const working = t.activeRunId !== null || ACTIVE.has(t.status);
    const agent: Agent = t.pendingRequest || (t.hasActionableProposedPlan && !working) ? "needs-you" : working ? "working" : "idle";
    const worktreePath = t.worktreePath ?? null;
    const key = JSON.stringify([t.machineId, t.projectId, worktreePath ?? t.branch]);
    const current = items.get(key);
    if (current) {
      current.threadIds.push(t.id);
      if (agent === "needs-you" || (agent === "working" && current.agent === "idle")) current.agent = agent;
      current.pr ??= t.pr ?? null;
      current.taskId ??= taskOf.get(`${t.machineId}\0${t.id}`) ?? null;
      continue;
    }
    items.set(key, {
      key,
      machineId: t.machineId,
      projectId: t.projectId,
      branch: t.branch,
      worktreePath,
      cwd: worktreePath ?? root,
      threadIds: [t.id],
      title: t.title,
      taskId: taskOf.get(`${t.machineId}\0${t.id}`) ?? null,
      agent,
      pr: t.pr ?? null,
      updatedAt: t.updatedAt,
    });
  }
  return [...items.values()];
}

export const statusKey = (item: Pick<WorkItem, "machineId" | "cwd">) => `${item.machineId}\0${item.cwd}`;

/** The newest checkouts, one read per (machine, cwd), at most `cap`. */
export function pickStatusItems(items: WorkItem[], cap = STATUS_CAP): WorkItem[] {
  const picked = new Map<string, WorkItem>();
  for (const item of [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    if (!picked.has(statusKey(item)) && picked.size < cap) picked.set(statusKey(item), item);
  return [...picked.values()];
}

/** A checkout may have been switched outside T3; its status belongs only to the observed branch. */
export const usableStatus = (item: Pick<WorkItem, "branch">, status: VcsStatus | null) =>
  status?.refName === item.branch ? status : null;

/** Why the work cannot be cleaned up yet; null when nothing would be lost. Unknown never counts as safe. */
export function closeBlocker(agent: Agent, status: VcsStatus | null, pr: WorkPr | null): string | null {
  if (agent !== "idle") return agent === "working" ? "Agent is working" : "Needs your attention";
  if (!status) return "Status not loaded";
  if (status.changedFiles) return `${status.changedFiles} uncommitted`;
  const remote = status.remote;
  if (!remote) return "Remote status unknown";
  if (remote.aheadCount > 0) return `${remote.aheadCount} commits not pushed`;
  if (pr?.state === "merged") return null;
  if (pr && pr.state !== "closed") return "PR not merged";
  if (!remote.hasUpstream) {
    if (remote.aheadOfDefaultCount === null) return "Upstream status unknown";
    if (remote.aheadOfDefaultCount > 0) return `${remote.aheadOfDefaultCount} commits not pushed`;
  }
  return null;
}

/** Index into STAGES from observed facts only; an unknown remote never implies a push. */
export function workStage(agent: Agent, status: VcsStatus | null, pr: WorkPr | null): { stage: number; blocked: string | null } {
  const blocked = closeBlocker(agent, status, pr);
  const r = status?.remote;
  const stage =
    pr?.state === "merged"
      ? blocked === null ? 6 : 5
      : pr && pr.state !== "closed"
        ? 4
        : agent !== "idle" || status?.changedFiles
          ? 1
          : r && (r.aheadCount > 0 || (!r.hasUpstream && (r.aheadOfDefaultCount ?? 0) > 0))
            ? 2
            : r?.hasUpstream
              ? 3
              : 0;
  return { stage, blocked };
}

/** merged: its PR merged. stale: idle, clean, not the default branch, PR closed or no activity for 14 days. */
export function tidyKind(agent: Agent, status: VcsStatus | null, pr: WorkPr | null, updatedAt: string, now: number): "merged" | "stale" | null {
  if (agent !== "idle" || status?.isDefaultRef) return null;
  if (pr?.state === "merged") return "merged";
  if (!status || status.changedFiles) return null;
  return pr?.state === "closed" || now - Date.parse(updatedAt) > STALE_MS ? "stale" : null;
}

export interface WorkRow {
  key: string;
  branch: string;
  worktreePath: string | null;
  /** Newest thread's title. */
  title: string;
  threadCount: number;
  taskId: string | null;
  agent: Agent;
  /** Index into STAGES. */
  stage: number;
  blocked: string | null;
  tidy: "merged" | "stale" | null;
  /** Null when unknown (status not read, or remote never fetched by T3). */
  changedFiles: number | null;
  ahead: number | null;
  behind: number | null;
  pr: WorkPr | null;
  /** Why status is missing or partial, e.g. "Checkout is on main". */
  note: string | null;
  updatedAt: string;
  appUrl: string;
  webUrl: string | null;
}

export interface WorkLane {
  projectId: string;
  title: string;
  rows: WorkRow[];
}

export interface WorkMachine {
  id: string;
  label: string;
  status: LinkStatus;
  lanes: WorkLane[];
}

/** Type contract for the web (merge into Api when wiring). */
export interface WorkApi {
  "GET /api/work": { body: never; res: WorkMachine[] };
  "POST /api/work/tidy": { body: { machineId: string; projectId: string }; res: Task };
}

/** The tidy task's prompt. Every destructive step stays with the agent, behind T3's command approvals. */
export function tidyPrompt(projectTitle: string, rows: WorkRow[]): string {
  const line = (r: WorkRow) =>
    `- ${r.branch}${r.worktreePath ? ` (worktree ${r.worktreePath})` : ""}${r.pr ? ` PR #${r.pr.number} ${r.pr.state ?? ""}`.trimEnd() : ""}`;
  const merged = rows.filter((r) => r.tidy === "merged").map(line);
  const stale = rows.filter((r) => r.tidy === "stale").map(line);
  return [
    `Tidy finished branches in ${projectTitle}. Work only on the branches listed here.`,
    ...(merged.length ? ["", "Merged (their pull request is merged):", ...merged] : []),
    ...(stale.length ? ["", "Stale (pull request closed, or no activity for 14 days):", ...stale] : []),
    "",
    "Check each branch yourself with git first. Never touch the default branch, and never remove a worktree or delete a branch that has uncommitted changes or commits that are on no remote and not merged.",
    "For a merged branch that is safe: remove its worktree (git worktree remove, without --force) and delete the local branch (git branch -d, never -D).",
    "For a stale branch: delete nothing. Report what is left on it (uncommitted files, unpushed commits, last commit date) and recommend keep or delete.",
    "Never push, force-push, merge, rebase or reset. End with a short list of what you removed and what needs my decision.",
  ].join("\n");
}

export interface WorkDeps {
  machines(): MachineView[];
  projects(): ProjectRow[];
  threads(): Row[];
  tasks(): Pick<Task, "id" | "machineId" | "threadId">[];
  /** Work methods are optional so a plain T3Link (e.g. a test fake) reads as unsupported. */
  link(machineId: string): (T3Link & Partial<WorkLink>) | undefined;
  createTask(input: TaskInput): Task;
  now?: () => number;
}

interface Entry<T> {
  at: number;
  value: T | null;
  error: string | null;
  inflight: Promise<void> | null;
}

export function createWork(deps: WorkDeps) {
  const now = deps.now ?? Date.now;
  const statuses = new Map<string, Entry<VcsStatus | null>>();
  const merged = new Map<string, Entry<MergedPr[]>>();

  /** Single-flight, fresh for FRESH_MS. Returns the pending read, or null when the cache is fresh. */
  function load<T>(cache: Map<string, Entry<T>>, key: string, fetch: () => Promise<T>): Promise<void> | null {
    const hit = cache.get(key);
    if (hit?.inflight) return hit.inflight;
    if (hit && now() - hit.at < FRESH_MS) return null;
    const e: Entry<T> = hit ?? { at: 0, value: null, error: null, inflight: null };
    cache.set(key, e);
    e.at = now();
    e.inflight = fetch()
      .then(
        (value) => void Object.assign(e, { value, error: null }),
        (error: unknown) => void Object.assign(e, { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => (e.inflight = null));
    return e.inflight;
  }
  const unsupported = () => Promise.reject(new Error("Not supported by this link."));

  async function read(): Promise<WorkMachine[]> {
    const machines = deps.machines();
    const projects = deps.projects();
    const items = deriveWorkItems(deps.threads(), projects, deps.tasks());
    const online = (id: string) => deps.link(id)?.state.status === "online";
    const picked = pickStatusItems(items.filter((i) => online(i.machineId)));
    const wanted = new Set(picked.map(statusKey));
    for (const key of statuses.keys()) if (!wanted.has(key)) statuses.delete(key);

    const reads: Promise<void>[] = [];
    for (const item of picked) {
      const link = deps.link(item.machineId)!;
      const r = load(statuses, statusKey(item), () => (link.vcsStatus ? link.vcsStatus(item.cwd) : unsupported()));
      if (r) reads.push(r);
    }
    for (const m of machines) {
      const link = deps.link(m.id);
      const ids = [...new Set(items.filter((i) => i.machineId === m.id).map((i) => i.projectId))];
      if (!link || !online(m.id) || !ids.length) continue;
      const r = load(merged, m.id, () => (link.mergedPullRequests ? link.mergedPullRequests(ids) : unsupported()));
      if (r) reads.push(r);
    }
    if (reads.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(reads), new Promise((ok) => (timer = setTimeout(ok, WAIT_MS)))]);
      clearTimeout(timer);
    }

    const t = now();
    const title = new Map(projects.map((p) => [`${p.machineId}\0${p.id}`, p.title]));
    return machines.flatMap((m): WorkMachine[] => {
      const lanes = new Map<string, WorkLane>();
      for (const item of items) {
        if (item.machineId !== m.id) continue;
        const entry = online(m.id) && wanted.has(statusKey(item)) ? statuses.get(statusKey(item)) : undefined;
        const status = usableStatus(item, entry?.value ?? null);
        const mergedPr = merged.get(m.id)?.value?.find((p) => p.projectId === item.projectId && p.headBranch === item.branch);
        const pr =
          status?.remote?.pr ?? (item.pr?.state ? item.pr : mergedPr ? { number: mergedPr.number, url: mergedPr.url, state: "merged" as const, isDraft: false } : item.pr);
        const note = !online(m.id)
          ? `Machine is ${m.link.status}`
          : !entry
            ? `Not read: only the ${STATUS_CAP} most recent checkouts are`
            : entry.inflight && !entry.value && !entry.error
              ? "Reading..."
              : entry.error && !entry.value
                ? entry.error
                : !entry.value
                  ? "Not a git repository"
                  : !status
                    ? `Checkout is on ${entry.value.refName ?? "a detached HEAD"}`
                    : !status.remote
                      ? "T3 has not fetched this branch's remote yet"
                      : null;
        const links = threadLinks(m, item.threadIds[0]!);
        const row: WorkRow = {
          key: item.key,
          branch: item.branch,
          worktreePath: item.worktreePath,
          title: item.title,
          threadCount: item.threadIds.length,
          taskId: item.taskId,
          agent: item.agent,
          ...workStage(item.agent, status, pr),
          tidy: tidyKind(item.agent, status, pr, item.updatedAt, t),
          changedFiles: status ? status.changedFiles : null,
          ahead: status?.remote?.aheadCount ?? null,
          behind: status?.remote?.behindCount ?? null,
          pr,
          note,
          updatedAt: item.updatedAt,
          ...links,
        };
        const lane = lanes.get(item.projectId) ?? { projectId: item.projectId, title: title.get(`${m.id}\0${item.projectId}`) ?? item.projectId, rows: [] };
        lane.rows.push(row);
        lanes.set(item.projectId, lane);
      }
      // Items arrive newest first, so each lane's first row is its latest activity.
      const sorted = [...lanes.values()].sort((a, b) => b.rows[0]!.updatedAt.localeCompare(a.rows[0]!.updatedAt));
      return sorted.length ? [{ id: m.id, label: m.label, status: m.link.status, lanes: sorted }] : [];
    });
  }

  async function tidy(body: unknown): Promise<Task> {
    const { machineId, projectId } = (body ?? {}) as { machineId?: unknown; projectId?: unknown };
    if (typeof machineId !== "string" || typeof projectId !== "string") throw new HttpError(400, "bad_request", "machineId and projectId are required");
    const lane = (await read()).find((m) => m.id === machineId)?.lanes.find((l) => l.projectId === projectId);
    const rows = lane?.rows.filter((r) => r.tidy) ?? [];
    if (!lane || !rows.length) throw new HttpError(409, "nothing_to_tidy", "No merged or stale branches in this project.");
    try {
      return deps.createTask({ title: `Tidy branches: ${lane.title}`, prompt: tidyPrompt(lane.title, rows), machineId, projectId, workspace: { type: "root" } });
    } catch (e) {
      if (e instanceof TaskError) throw new HttpError(e.code === "invalid" ? 400 : e.code === "not_found" ? 404 : 409, e.code, e.message);
      throw e;
    }
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/work", auth: "cookie", handler: read },
    { method: "POST", path: "/api/work/tidy", auth: "cookie", handler: ({ body }) => tidy(body) },
  ];
  return { read, tidy, routes };
}
