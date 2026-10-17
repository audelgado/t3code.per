// Task service and the 24/7 dispatcher. Talks to T3 only through T3Link.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DatabaseSync } from "node:sqlite";
import { getMachine, getProject, getTask, insertTask, listTasks, replaceProjects, updateTask } from "./db.ts";
import {
  T3Error,
  type LaunchInput,
  type LinkState,
  type ModelSelection,
  type RuntimeMode,
  type ShellUpdate,
  type T3Link,
  type Task,
  type TaskInput,
  type TaskSource,
  type TaskStatus,
  type ThreadRow,
} from "./types.ts";
import { usageLimitWaiting, type ProviderPause } from "./view.ts";

/** Maps to HTTP 400 / 404 / 409. */
export class TaskError extends Error {
  readonly code: "invalid" | "not_found" | "conflict";
  constructor(code: "invalid" | "not_found" | "conflict", message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

const ACTIVE: TaskStatus[] = ["starting", "running", "waiting", "needs_you"];
/** Waiting (usage limit) tasks do not hold a slot. */
const HOLDS_SLOT: TaskStatus[] = ["starting", "running", "needs_you"];
const RUNTIME_MODES = new Set<RuntimeMode>(["approval-required", "auto-accept-edits", "auto", "full-access"]);
const MINUTE = 60_000;
const UNSEEN_RELAUNCH_MS = MINUTE;
const RESULT_MAX = 4000;

/** Task status a live thread row implies; null = launched but no run yet, keep the current status. */
export function taskStatusFor(row: ThreadRow, now: number): TaskStatus | null {
  if (row.pendingRequest) return "needs_you";
  if (row.status === "completed") return "done";
  if (row.status === "interrupted" || row.status === "cancelled" || row.status === "rolled_back") return "cancelled";
  if (usageLimitWaiting(row, now)) return "waiting";
  if (row.status === "failed") return "failed";
  if (row.status === "idle") return null;
  return "running";
}

function validWorkspace(w: unknown): boolean {
  if (typeof w !== "object" || w === null) return false;
  const o = w as Record<string, unknown>;
  if (o.branch !== undefined && typeof o.branch !== "string") return false;
  if (o.type === "root") return true;
  if (o.type === "worktree") return typeof o.baseRef === "string" && (o.startFromOrigin === undefined || typeof o.startFromOrigin === "boolean");
  return o.type === "existing_worktree" && typeof o.worktreePath === "string";
}
const validModel = (m: unknown) =>
  m == null || (typeof m === "object" && typeof (m as ModelSelection).instanceId === "string" && typeof (m as ModelSelection).model === "string");
const validPriority = (p: unknown): p is number => Number.isInteger(p) && (p as number) >= -2 && (p as number) <= 2;

export interface DispatcherOptions {
  db: DatabaseSync;
  /** The live link of a machine, if any. */
  link: (machineId: string) => T3Link | undefined;
  now?: () => number;
  newId?: () => string;
}

/**
 * Emits "changed" whenever tasks, live threads, link states or pauses change.
 * Wire it as the LinkEvents of every link: onShell/onState match that interface.
 */
export class Dispatcher extends EventEmitter<{ changed: [] }> {
  readonly #db: DatabaseSync;
  readonly #link: (machineId: string) => T3Link | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  /** Last shell update per machine. */
  readonly #shells = new Map<string, ShellUpdate>();
  readonly #projectsJson = new Map<string, string>();
  /** "<machineId>\0<instanceId>" → pause. In memory: after a restart the first snapshot re-pauses. */
  readonly #pauses = new Map<string, ProviderPause>();
  /** When this process last called launch() for a starting task; absent = must (re)launch. */
  readonly #launchedAt = new Map<string, number>();
  /** Tasks whose result is being read; guards against a second read from the next shell update. */
  readonly #finishing = new Set<string>();
  /**
   * "<machineId>\0<threadId>" of tasks cancelled before their run was visible; interrupted once it shows up.
   * ponytail: in memory, so a restart in that window lets the run continue; persist it if that bites.
   */
  readonly #stopOnSight = new Set<string>();
  #inFlight: Promise<void> | null = null;
  #again = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(opts: DispatcherOptions) {
    super();
    this.#db = opts.db;
    this.#link = opts.link;
    this.#now = opts.now ?? Date.now;
    this.#newId = opts.newId ?? randomUUID;
  }

  #iso = () => new Date(this.#now()).toISOString();
  #changed() {
    this.emit("changed");
    void this.dispatch();
  }
  #get(id: string): Task {
    const task = getTask(this.#db, id);
    if (!task) throw new TaskError("not_found", "No se encontró la tarea");
    return task;
  }
  #online(machineId: string) {
    return this.#link(machineId)?.state.status === "online";
  }

  // ---- task service ----

  createTask(input: TaskInput, source: TaskSource): Task {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 20_000) throw new TaskError("invalid", "prompt must be 1-20000 characters");
    if (typeof input.machineId !== "string" || typeof input.projectId !== "string" || !getProject(this.#db, input.machineId, input.projectId))
      throw new TaskError("invalid", "unknown project");
    const priority = input.priority ?? 0;
    if (!validPriority(priority)) throw new TaskError("invalid", "priority must be an integer from -2 to 2");
    const dependsOn = input.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string" || !getTask(this.#db, id)))
      throw new TaskError("invalid", "unknown dependency");
    if (input.runtimeMode !== undefined && !RUNTIME_MODES.has(input.runtimeMode)) throw new TaskError("invalid", "invalid runtimeMode");
    const interactionMode = input.interactionMode ?? "default";
    if (interactionMode !== "default" && interactionMode !== "plan") throw new TaskError("invalid", "invalid interactionMode");
    const workspace = input.workspace ?? { type: "root" };
    if (!validWorkspace(workspace)) throw new TaskError("invalid", "invalid workspace");
    if (!validModel(input.model)) throw new TaskError("invalid", "invalid model");
    if (input.title !== undefined && typeof input.title !== "string") throw new TaskError("invalid", "invalid title");

    const agent = source !== "user";
    const now = this.#iso();
    const task: Task = {
      id: this.#newId(),
      title: (input.title?.trim() || prompt.split("\n")[0]!.trim()).slice(0, 60),
      prompt,
      machineId: input.machineId,
      projectId: input.projectId,
      model: input.model ?? null,
      // Agents never pick a runtime mode; the human approver does.
      runtimeMode: agent ? null : (input.runtimeMode ?? "full-access"),
      interactionMode,
      workspace,
      priority,
      dependsOn: [...new Set(dependsOn)],
      source,
      status: agent ? "pending_approval" : "queued",
      commandId: null,
      threadId: null,
      threadSeenAt: null,
      limitResetAt: null,
      error: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    insertTask(this.#db, task);
    this.#changed();
    return task;
  }

  approve(id: string, opts: { runtimeMode?: RuntimeMode }): Task {
    const task = this.#get(id);
    if (task.status !== "pending_approval") throw new TaskError("conflict", "La tarea no está por aprobar");
    const runtimeMode = opts.runtimeMode ?? task.runtimeMode;
    if (!runtimeMode || !RUNTIME_MODES.has(runtimeMode)) throw new TaskError("invalid", "runtimeMode is required");
    const next = updateTask(this.#db, id, { status: "queued", runtimeMode });
    this.#changed();
    return next;
  }

  reject(id: string): Task {
    const task = this.#get(id);
    if (task.status !== "pending_approval") throw new TaskError("conflict", "La tarea no está por aprobar");
    const next = updateTask(this.#db, id, { status: "cancelled", error: "rejected", finishedAt: this.#iso() });
    this.#changed();
    return next;
  }

  /** Queued tasks cancel locally; active ones interrupt their T3 run first (errors propagate, task unchanged). */
  async cancel(id: string): Promise<Task> {
    const task = this.#get(id);
    if (ACTIVE.includes(task.status)) {
      const row = this.#row(task);
      const link = this.#link(task.machineId);
      if (row?.activeRunId && link?.state.status === "online") await link.interrupt(row.id, row.activeRunId);
      else if (task.threadId) this.#stopOnSight.add(`${task.machineId}\0${task.threadId}`);
    } else if (task.status !== "queued" && task.status !== "pending_approval") {
      throw new TaskError("conflict", `La tarea está en estado ${task.status}`);
    }
    const current = this.#get(id);
    if (current.status !== task.status) return current; // finished while we interrupted
    const next = updateTask(this.#db, id, { status: "cancelled", error: "cancelled", finishedAt: this.#iso() });
    this.#launchedAt.delete(id);
    this.#changed();
    return next;
  }

  /** Re-queues a finished task; it gets new T3 ids when it dispatches. */
  retry(id: string): Task {
    const task = this.#get(id);
    if (task.status !== "failed" && task.status !== "cancelled") throw new TaskError("conflict", `La tarea está en estado ${task.status}`);
    const next = updateTask(this.#db, id, {
      status: task.runtimeMode === null ? "pending_approval" : "queued",
      commandId: null,
      threadId: null,
      threadSeenAt: null,
      limitResetAt: null,
      error: null,
      result: null,
      startedAt: null,
      finishedAt: null,
    });
    this.#changed();
    return next;
  }

  setPriority(id: string, priority: number): Task {
    this.#get(id);
    if (!validPriority(priority)) throw new TaskError("invalid", "priority must be an integer from -2 to 2");
    const next = updateTask(this.#db, id, { priority });
    this.#changed();
    return next;
  }

  // ---- live state ----

  /** Latest live rows of every machine (for HomeView and /healthz). */
  threads(): ThreadRow[] {
    return [...this.#shells.values()].flatMap((s) => s.threads);
  }

  pauses(): ProviderPause[] {
    const now = this.#now();
    return [...this.#pauses.values()].filter((p) => Date.parse(p.until) > now);
  }

  #row(task: Task) {
    return this.#shells.get(task.machineId)?.threads.find((r) => r.id === task.threadId);
  }

  #paused(machineId: string, instanceId: string, now: number) {
    const pause = this.#pauses.get(`${machineId}\0${instanceId}`);
    return pause !== undefined && Date.parse(pause.until) > now;
  }

  onState(_machineId: string, state: LinkState) {
    this.emit("changed");
    if (state.status === "online") void this.dispatch();
  }

  /** Applies one shell update. The promise settles once results of newly finished tasks are stored. */
  onShell(machineId: string, shell: ShellUpdate): Promise<void> {
    const now = this.#now();
    this.#shells.set(machineId, shell);
    const projectsJson = JSON.stringify(shell.projects);
    if (this.#projectsJson.get(machineId) !== projectsJson) {
      replaceProjects(this.#db, machineId, shell.projects);
      this.#projectsJson.set(machineId, projectsJson);
    }

    // Any thread (CC or not) at a usage limit pauses that provider instance on this machine until the latest reset.
    for (const row of shell.threads) {
      if (!usageLimitWaiting(row, now)) continue;
      const reset = Date.parse(row.usageLimitResetAt!);
      const key = `${machineId}\0${row.providerInstanceId}`;
      const current = this.#pauses.get(key);
      const active = current !== undefined && Date.parse(current.until) > now;
      if (reset <= now || (active && Date.parse(current.until) >= reset)) continue;
      const since = active ? current.since : new Date(now).toISOString();
      this.#pauses.set(key, { machineId, instanceId: row.providerInstanceId, since, until: new Date(reset).toISOString() });
    }

    const rows = new Map(shell.threads.map((r) => [r.id, r]));
    for (const key of this.#stopOnSight) {
      const [m, threadId] = key.split("\0");
      const row = m === machineId ? rows.get(threadId!) : undefined;
      if (!row?.activeRunId) continue;
      this.#stopOnSight.delete(key);
      this.#link(machineId)?.interrupt(row.id, row.activeRunId).catch(() => {});
    }
    const finishing: Promise<void>[] = [];
    for (const task of listTasks(this.#db, [...ACTIVE, "failed", "cancelled"])) {
      if (task.machineId !== machineId || !task.threadId || this.#finishing.has(task.id)) continue;
      const row = rows.get(task.threadId);
      if (!ACTIVE.includes(task.status)) {
        // A user can resume the same thread in T3 after its CC task finished unsuccessfully.
        // Local cancellations remain final; only a newer live continuation can recover a T3 outcome.
        if (!row || (task.status === "cancelled" && !["cancelled in T3", "interrupted in T3", "rolled_back in T3"].includes(task.error ?? "")) || !task.finishedAt || Date.parse(row.updatedAt) <= Date.parse(task.finishedAt)) continue;
        const resumed = taskStatusFor(row, now);
        if (!resumed || !["done", "running", "waiting", "needs_you"].includes(resumed)) continue;
        updateTask(this.#db, task.id, { status: "running", error: null, finishedAt: null });
      }
      if (!row) {
        // Rows are the machine's full live set, so a thread we saw before is gone (removed or archived).
        if (task.threadSeenAt) finishing.push(this.#finish(task, "cancelled", "removed in T3", false));
        continue;
      }
      const patch: Partial<Task> = {};
      if (!task.threadSeenAt) patch.threadSeenAt = new Date(now).toISOString();
      const next = taskStatusFor(row, now);
      if (next === "done" || next === "failed" || next === "cancelled") {
        if (patch.threadSeenAt) updateTask(this.#db, task.id, patch);
        const error =
          next === "failed"
            ? row.usageLimitResetAt !== null
              ? "usage limit; resume in T3"
              : (row.lastError ?? "failed")
            : next === "cancelled"
              ? `${row.status} in T3`
              : null;
        finishing.push(this.#finish(task, next, error, true));
        continue;
      }
      if (next !== null && next !== task.status) patch.status = next;
      const limitResetAt = next === "waiting" ? row.usageLimitResetAt : null;
      if (limitResetAt !== task.limitResetAt) patch.limitResetAt = limitResetAt;
      if (Object.keys(patch).length > 0) updateTask(this.#db, task.id, patch);
    }
    this.#changed();
    return Promise.all(finishing).then(() => undefined);
  }

  /** Reads the result once (before the status flips, so dependents see it), then stores the terminal status. */
  async #finish(task: Task, status: "done" | "failed" | "cancelled", error: string | null, read: boolean) {
    this.#finishing.add(task.id);
    let result: string | null = null;
    if (read) {
      try {
        result = (await this.#link(task.machineId)?.readResult(task.threadId!))?.text?.slice(0, RESULT_MAX) ?? null;
      } catch {
        // The thread stays readable in T3; the task finishes without a stored result.
      }
    }
    this.#finishing.delete(task.id);
    if (!ACTIVE.includes(this.#get(task.id).status)) return; // cancelled by the user meanwhile
    updateTask(this.#db, task.id, { status, error, result, limitResetAt: null, finishedAt: this.#iso() });
    this.#launchedAt.delete(task.id);
    this.#changed();
  }

  // ---- dispatch ----

  /** Re-applies each machine's last shell, for rules that change with time alone (the usage-limit grace), then dispatches. */
  async tick() {
    await Promise.all([...this.#shells].map(([id, shell]) => this.onShell(id, shell)));
    await this.dispatch();
  }

  start() {
    this.#timer ??= setInterval(() => void this.tick(), 30_000);
    this.#timer.unref();
    void this.dispatch();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Single-flight: a call during a pass schedules one more pass and shares its promise. */
  dispatch(): Promise<void> {
    if (this.#inFlight) {
      this.#again = true;
      return this.#inFlight;
    }
    this.#inFlight = (async () => {
      try {
        do {
          this.#again = false;
          await this.#pass();
        } while (this.#again);
      } finally {
        this.#inFlight = null;
      }
    })();
    return this.#inFlight;
  }

  // ponytail: one global loop, fine for hundreds of tasks.
  async #pass() {
    const now = this.#now();
    const tasks = listTasks(this.#db);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    // Starting tasks this process never launched (crash, transport error) or T3 never showed within 60 s:
    // relaunch with the same ids; the command receipt makes it idempotent.
    for (const task of tasks) {
      if (task.status !== "starting" || task.threadSeenAt || !this.#online(task.machineId)) continue;
      const at = this.#launchedAt.get(task.id);
      if (at === undefined || now - at >= UNSEEN_RELAUNCH_MS) await this.#launch(task, byId);
    }

    const load = new Map<string, number>();
    const rootBusy = new Set<string>();
    for (const t of tasks) {
      if (HOLDS_SLOT.includes(t.status)) load.set(t.machineId, (load.get(t.machineId) ?? 0) + 1);
      if (ACTIVE.includes(t.status) && t.workspace.type === "root") rootBusy.add(`${t.machineId}\0${t.projectId}`);
    }
    const queued = tasks
      .filter((t) => t.status === "queued")
      .sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const task of queued) {
      if (task.runtimeMode === null) continue;
      if (!task.dependsOn.every((id) => byId.get(id)?.status === "done")) continue;
      const link = this.#link(task.machineId);
      if (link?.state.status !== "online") continue;
      const machine = getMachine(this.#db, task.machineId);
      if (!machine?.enabled || (load.get(task.machineId) ?? 0) >= machine.maxConcurrent) continue;
      const projectKey = `${task.machineId}\0${task.projectId}`;
      // Two root tasks on one checkout would edit the same files; worktree tasks never conflict.
      if (task.workspace.type === "root" && rootBusy.has(projectKey)) continue;
      let model: ModelSelection | null;
      try {
        model = await this.#resolveModel(task, link);
      } catch {
        continue; // providers() unreachable; next pass retries
      }
      // This pass awaited T3 (providers, earlier launches): a cancel may have landed meanwhile.
      const fresh = getTask(this.#db, task.id);
      if (fresh?.status !== "queued" || fresh.runtimeMode === null) continue;
      if (!model) {
        byId.set(task.id, updateTask(this.#db, task.id, { status: "failed", error: "no model", finishedAt: this.#iso() }));
        this.emit("changed");
        continue;
      }
      if (this.#paused(task.machineId, model.instanceId, now)) continue;
      // Persist ids before launching: a crash in between relaunches with the same ids.
      const started = updateTask(this.#db, task.id, {
        status: "starting",
        model,
        commandId: this.#newId(),
        threadId: this.#newId(),
        startedAt: this.#iso(),
      });
      byId.set(task.id, started);
      load.set(task.machineId, (load.get(task.machineId) ?? 0) + 1);
      if (task.workspace.type === "root") rootBusy.add(projectKey);
      this.emit("changed");
      await this.#launch(started, byId);
    }
  }

  async #resolveModel(task: Task, link: T3Link): Promise<ModelSelection | null> {
    if (task.model) return task.model;
    const project = getProject(this.#db, task.machineId, task.projectId);
    if (project?.defaultModel) return project.defaultModel;
    for (const p of await link.providers()) {
      const model = p.enabled && p.installed ? (p.models.find((m) => m.isDefault) ?? p.models[0]) : undefined;
      if (model) return { instanceId: p.instanceId, model: model.slug };
    }
    return null;
  }

  /** Launches only while the task is still this same start: a cancel or retry during earlier awaits wins. */
  async #launch(task: Task, byId: Map<string, Task>) {
    const link = this.#link(task.machineId);
    const same = () => {
      const current = getTask(this.#db, task.id);
      return current?.status === "starting" && current.commandId === task.commandId;
    };
    if (!link || !same()) return;
    this.#launchedAt.set(task.id, this.#now());
    try {
      await link.launch(this.#launchInput(task, byId));
    } catch (e) {
      if (!same()) return;
      if (e instanceof T3Error) {
        updateTask(this.#db, task.id, { status: "failed", error: e.message, finishedAt: this.#iso() });
        this.#launchedAt.delete(task.id);
        this.emit("changed");
      } else {
        this.#launchedAt.delete(task.id); // transport error: stay starting, same ids next pass
      }
    }
  }

  #launchInput(task: Task, byId: Map<string, Task>): LaunchInput {
    const results = task.dependsOn.flatMap((id) => {
      const dep = byId.get(id);
      return dep?.result ? [`### ${dep.title}\n${dep.result.slice(0, RESULT_MAX)}`] : [];
    });
    return {
      commandId: task.commandId!,
      threadId: task.threadId!,
      projectId: task.projectId,
      title: task.title,
      modelSelection: task.model!,
      runtimeMode: task.runtimeMode!,
      interactionMode: task.interactionMode,
      workspaceStrategy: task.workspace,
      prompt: results.length > 0 ? `${task.prompt}\n\nResults from earlier tasks:\n\n${results.join("\n\n")}` : task.prompt,
    };
  }
}
