import assert from "node:assert/strict";
import { test } from "node:test";
import type { VcsStatus, WorkPr } from "./t3link.ts";
import type { LinkState, MachineView, ProjectRow, Task, TaskInput } from "./types.ts";
import { HttpError } from "./http.ts";
import { closeBlocker, createWork, deriveWorkItems, FRESH_MS, pickStatusItems, STATUS_CAP, tidyKind, tidyPrompt, workStage, type WorkItem } from "./work.ts";

const project = (id: string, machineId = "pc"): ProjectRow => ({ machineId, id, title: `Project ${id}`, workspaceRoot: `/${id}`, defaultModel: null, updatedAt: "" });
type Row = Parameters<typeof deriveWorkItems>[0][number];
const row = (id: string, patch: Partial<Row> = {}): Row => ({
  machineId: "pc",
  id,
  projectId: "p",
  title: `Thread ${id}`,
  status: "idle",
  activityRunStatus: null,
  activeRunId: null,
  pendingRequest: null,
  hasActionableProposedPlan: false,
  lastError: null,
  usageLimitResetAt: null,
  relationshipToParent: null,
  snoozedUntil: null,
  settledAt: null,
  providerInstanceId: "codex",
  completedAt: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
  branch: "feature",
  worktreePath: "/work",
  pr: null,
  ...patch,
});
const status = (patch: Partial<VcsStatus> = {}, remote: Partial<NonNullable<VcsStatus["remote"]>> | null = {}): VcsStatus => ({
  refName: "feature",
  isDefaultRef: false,
  hasPrimaryRemote: true,
  changedFiles: 0,
  remote: remote && { hasUpstream: false, aheadCount: 0, behindCount: 0, aheadOfDefaultCount: 0, pr: null, ...remote },
  ...patch,
});
const pr = (state: WorkPr["state"]): WorkPr => ({ number: 1, url: "https://example.com/1", state, isDraft: false });

test("groups threads by machine, project and checkout, newest thread first", () => {
  const items = deriveWorkItems(
    [
      row("old", { updatedAt: "2026-10-13T00:00:00Z", pendingRequest: { id: "r", kind: "command", summary: null, createdAt: "" } }),
      row("new"),
      row("root", { worktreePath: null }),
      row("clone", { projectId: "clone" }),
      row("remote", { machineId: "vps" }),
    ],
    [project("p"), project("clone"), project("p", "vps")],
    [{ id: "task-1", machineId: "pc", threadId: "old" }],
  );
  assert.equal(items.length, 4);
  const grouped = items.find((i) => i.threadIds.length === 2)!;
  assert.deepEqual(grouped.threadIds, ["new", "old"]);
  assert.equal(grouped.title, "Thread new");
  assert.equal(grouped.agent, "needs-you");
  assert.equal(grouped.taskId, "task-1");
  assert.equal(items.find((i) => i.threadIds[0] === "root")!.cwd, "/p");
  assert.equal(new Set(items.map((i) => i.key)).size, 4);
});

test("skips subagent, branchless and unknown-project threads; running threads are working", () => {
  const items = deriveWorkItems(
    [row("child", { relationshipToParent: "subagent" }), row("no-branch", { branch: null }), row("missing", { projectId: "missing" }), row("run", { status: "running", worktreePath: "/run" })],
    [project("p")],
    [],
  );
  assert.deepEqual(items.map((i) => [i.threadIds[0], i.agent]), [["run", "working"]]);
  // A ready plan needs you only once the agent stopped.
  assert.equal(deriveWorkItems([row("plan", { hasActionableProposedPlan: true })], [project("p")], [])[0]!.agent, "needs-you");
});

test("derives all seven stages from observed status", () => {
  const stage = (s: VcsStatus | null, p: WorkPr | null = null) => workStage("idle", s, p).stage;
  assert.equal(stage(status()), 0);
  assert.equal(stage(status({ changedFiles: 2 })), 1);
  assert.equal(workStage("working", status(), null).stage, 1);
  assert.equal(stage(status({}, { aheadCount: 2 })), 2);
  assert.equal(stage(status({}, { hasUpstream: true })), 3);
  assert.equal(stage(status(), pr("open")), 4);
  assert.equal(stage(status({ changedFiles: 1 }), pr("merged")), 5);
  assert.equal(stage(status(), pr("merged")), 6);
  assert.equal(stage(null), 0);
  // An unknown remote never implies a push.
  assert.equal(stage(status({}, null)), 0);
});

test("cleanup is blocked by dirty, unpublished or unknown work", () => {
  assert.equal(closeBlocker("idle", status(), null), null);
  assert.equal(closeBlocker("idle", status({}, { hasUpstream: true }), null), null);
  assert.equal(closeBlocker("idle", status(), pr("merged")), null);
  assert.equal(closeBlocker("idle", status({ changedFiles: 1 }), pr("merged")), "1 uncommitted");
  assert.equal(closeBlocker("idle", status({}, { aheadCount: 5 }), pr("merged")), "5 commits not pushed");
  assert.equal(closeBlocker("idle", status({}, { aheadOfDefaultCount: 3 }), null), "3 commits not pushed");
  assert.equal(closeBlocker("idle", status({}, { aheadOfDefaultCount: null }), null), "Upstream status unknown");
  assert.equal(closeBlocker("idle", status(), pr("open")), "PR not merged");
  assert.equal(closeBlocker("idle", null, null), "Status not loaded");
  assert.equal(closeBlocker("idle", status({}, null), pr("merged")), "Remote status unknown");
  assert.equal(closeBlocker("working", status(), null), "Agent is working");
  assert.equal(closeBlocker("needs-you", status(), null), "Needs your attention");
});

test("tidy classifies observed facts only and never the default branch", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  const old = "2026-10-01T00:00:00Z";
  assert.equal(tidyKind("idle", null, pr("merged"), old, now), "merged");
  assert.equal(tidyKind("idle", status(), null, old, now), "stale");
  assert.equal(tidyKind("idle", status(), pr("closed"), "2026-10-29T00:00:00Z", now), "stale");
  assert.equal(tidyKind("idle", status(), null, "2026-10-29T00:00:00Z", now), null);
  assert.equal(tidyKind("idle", null, null, old, now), null);
  assert.equal(tidyKind("idle", status({ changedFiles: 1 }), null, old, now), null);
  assert.equal(tidyKind("idle", status({ isDefaultRef: true }), pr("merged"), old, now), null);
  assert.equal(tidyKind("working", status(), pr("merged"), old, now), null);
});

test("status reads cap at twenty unique checkouts, newest first", () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    deriveWorkItems([row(`t${i}`, { worktreePath: `/w${i}`, updatedAt: `2026-10-${String(i + 1).padStart(2, "0")}` })], [project("p")], [])[0]!,
  );
  const shared: WorkItem = { ...items[29]!, key: "other", branch: "other" };
  const picked = pickStatusItems([...items, shared]);
  assert.equal(picked.length, STATUS_CAP);
  assert.equal(picked[0], items[29]);
  assert.ok(!picked.includes(items[0]!));
  assert.equal(picked.filter((i) => i.cwd === "/w29").length, 1);
});

// ---- createWork ----

const machine = (id: string, linkStatus: LinkState["status"] = "online"): MachineView => ({
  id,
  label: id.toUpperCase(),
  apiUrl: "https://x",
  webUrl: null,
  maxConcurrent: 2,
  enabled: true,
  serverVersion: null,
  tokenExpiresAt: null,
  createdAt: "",
  link: { status: linkStatus } as LinkState,
  running: 0,
  queued: 0,
});

function setup(threads: Row[], opts: { vps?: LinkState["status"] } = {}) {
  let clock = Date.parse("2026-10-30T00:00:00Z");
  const calls: string[] = [];
  const created: TaskInput[] = [];
  const fake = (id: string, linkStatus: LinkState["status"]) => ({
    state: { status: linkStatus } as LinkState,
    vcsStatus: async (cwd: string) => (calls.push(`status ${id} ${cwd}`), cwd === "/merged" ? status({ refName: "merged" }, { hasUpstream: true }) : status()),
    mergedPullRequests: async (ids: string[]) => (calls.push(`prs ${id} ${ids.join(",")}`), [{ projectId: "p", headBranch: "merged", number: 7, url: "https://example.com/7" }]),
  });
  const links: Record<string, any> = { pc: fake("pc", "online"), vps: fake("vps", opts.vps ?? "online") };
  const work = createWork({
    machines: () => [machine("pc"), machine("vps", opts.vps ?? "online")],
    projects: () => [project("p"), project("p", "vps")],
    threads: () => threads,
    tasks: () => [],
    link: (id) => links[id],
    createTask: (input) => (created.push(input), { id: "task" } as Task),
    now: () => clock,
  });
  return { work, calls, created, tick: (ms: number) => (clock += ms) };
}

test("reads status and merged PRs only for online machines, single-flight, at most once per 30 s", async () => {
  const { work, calls, tick } = setup([row("a"), row("b", { machineId: "vps", worktreePath: "/b" }), row("m", { branch: "merged", worktreePath: "/merged" })], { vps: "offline" });
  const [first] = await Promise.all([work.read(), work.read()]);
  assert.deepEqual(calls.sort(), ["prs pc p", "status pc /merged", "status pc /work"]);
  const pc = first.find((m) => m.id === "pc")!.lanes[0]!;
  const merged = pc.rows.find((r) => r.branch === "merged")!;
  assert.deepEqual([merged.pr?.number, merged.pr?.state, merged.stage, merged.tidy], [7, "merged", 6, "merged"]);
  const vps = first.find((m) => m.id === "vps")!.lanes[0]!.rows[0]!;
  assert.equal(vps.note, "Machine is offline");
  assert.equal(vps.changedFiles, null);
  await work.read();
  assert.equal(calls.length, 3);
  tick(FRESH_MS);
  await work.read();
  assert.equal(calls.length, 6);
});

test("a checkout switched to another branch shows no status for this one", async () => {
  const { work } = setup([row("a", { branch: "gone" })]);
  const [pc] = await work.read();
  const r = pc!.lanes[0]!.rows[0]!;
  assert.equal(r.note, "Checkout is on feature");
  assert.equal(r.ahead, null);
});

test("tidy queues a user task in the project root listing merged branches; nothing to tidy is 409", async () => {
  const { work, created } = setup([row("a", { updatedAt: "2026-10-29T00:00:00Z" }), row("m", { branch: "merged", worktreePath: "/merged" })]);
  await work.tidy({ machineId: "pc", projectId: "p" });
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.workspace, { type: "root" });
  assert.match(created[0]!.prompt, /- merged \(worktree \/merged\) PR #7 merged/);
  assert.doesNotMatch(created[0]!.prompt, /- feature/);
  await assert.rejects(work.tidy({ machineId: "vps", projectId: "p" }), (e: unknown) => e instanceof HttpError && e.status === 409);
  await assert.rejects(work.tidy({}), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test("tidy prompt forbids pushes and force deletes", () => {
  const p = tidyPrompt("Repo", []);
  assert.match(p, /never -D/);
  assert.match(p, /Never push, force-push, merge, rebase or reset/);
});
