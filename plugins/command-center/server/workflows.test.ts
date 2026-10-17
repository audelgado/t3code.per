import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getTask, listTasks, openDb, replaceProjects, updateTask } from "./db.ts";
import { Dispatcher } from "./dispatcher.ts";
import type { ThreadRow } from "./types.ts";
import { T3Error } from "./types.ts";
import { checkPassed, createWorkflows, parseItems, parseWorkflow, type Workflow } from "./workflows.ts";

// A real dispatcher without links: tasks stay queued, and a test finishes them by hand.
function setup(t: { after(fn: () => void): void }, threads: () => ThreadRow[] = () => [], link: Parameters<typeof createWorkflows>[0]["link"] = () => undefined) {
  const home = mkdtempSync(join(tmpdir(), "cc-wf-"));
  const db = openDb(home);
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  replaceProjects(db, "m1", [{ machineId: "m1", id: "p1", title: "Repo", workspaceRoot: "/repo", defaultModel: null, updatedAt: "x" }]);
  const dispatcher = new Dispatcher({ db, link: () => undefined });
  let changes = 0;
  const wf = createWorkflows({ db, tasks: dispatcher, link, threads, onChange: () => changes++ });
  dispatcher.on("changed", wf.advance);
  const tasks = () => listTasks(db);
  const finish = (title: string, result: string, status: "done" | "failed" = "done") => {
    const task = tasks().find((x) => x.title.endsWith(title) && x.status === "queued");
    assert.ok(task, `no queued task "${title}"`);
    updateTask(db, task.id, { status, result });
    wf.advance();
    return task;
  };
  const run = (workflow: Workflow, inputs?: Record<string, string>, source: "user" | `agent:${string}` = "user") => {
    wf.save(workflow, "user");
    return wf.start({ slug: workflow.slug, machineId: "m1", projectId: "p1", inputs }, source).run.id;
  };
  return { db, dispatcher, wf, tasks, finish, run, changes: () => changes };
}

const base = { title: "Flow", description: "", inputs: [], edges: [] };
const agent = (id: string, prompt = `do ${id}`) => ({ id, kind: "agent" as const, prompt });

test("expands the DAG: each node waits for its edges and gets their results as dependencies", (t) => {
  const { wf, tasks, finish, run } = setup(t);
  const id = run({
    ...base,
    slug: "diamond",
    nodes: [agent("a"), agent("b"), agent("c"), agent("d"), { id: "check", kind: "gate", check: "tests" }],
    edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }, { from: "d", to: "check" }],
  });
  assert.deepEqual(tasks().map((x) => x.title), ["Flow: a"]);
  const a = finish("a", "A done");
  assert.deepEqual(tasks().filter((x) => x.status === "queued").map((x) => x.title).sort(), ["Flow: b", "Flow: c"]);
  assert.ok(tasks().filter((x) => x.status === "queued").every((x) => x.dependsOn.join() === a.id));
  const b = finish("b", "B");
  assert.equal(tasks().length, 3, "d waits for c too");
  const c = finish("c", "C");
  const d = tasks().find((x) => x.title === "Flow: d")!;
  assert.deepEqual(d.dependsOn, [b.id, c.id]);
  assert.match(d.prompt, /You are running the step "d" of the workflow "Flow"/);
  finish("d", "D");
  assert.match(tasks().find((x) => x.title === "Flow: check")!.prompt, /Start your reply with one line: PASS/);
  finish("check", "**PASS**\nAll green.");
  assert.equal(wf.detail(id).run.status, "succeeded");
});

test("managed project audits cannot reuse another project's context through generic start", (t) => {
  const { wf } = setup(t);
  wf.save({ ...base, slug: "cc-project-audit", nodes: [agent("a")], edges: [] }, "user");
  assert.throws(() => wf.start({ slug: "cc-project-audit", machineId: "m1", projectId: "p1" }, "user"), /managed workflow/);
});

test("rejects cycles and other graph problems", () => {
  const cyclic = parseWorkflow({ ...base, slug: "loop", nodes: [agent("a"), agent("b")], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
  assert.equal(cyclic.workflow, null);
  assert.match(cyclic.errors.join(), /cycle: a -> b -> a/);
  const bad = parseWorkflow({ ...base, slug: "Bad Slug", nodes: [{ id: "x", kind: "loop" }, agent("y", "{{input:missing}}")] });
  assert.ok(bad.errors.some((e) => e.startsWith("slug")));
  assert.ok(bad.errors.some((e) => e.includes('unknown kind "loop"')));
  assert.match(parseWorkflow({ ...base, slug: "ok", nodes: [agent("y", "{{input:missing}}")] }).errors.join(), /not declared in inputs/);
  assert.match(
    parseWorkflow({ ...base, slug: "ok", nodes: [agent("y"), { id: "p", kind: "parallel", over: "y", node: "y" }] }).errors.join(),
    /runs inside "p"/,
  );
  const { workflow } = parseWorkflow({ ...base, slug: "ok", nodes: [{ ...agent("a"), extra: 1 }], layout: {} });
  assert.deepEqual(workflow, { ...base, slug: "ok", nodes: [agent("a")], edges: [] });
});

test("ask and manual gates block until answered; only the user passes a gate", (t) => {
  const { wf, tasks, finish, run } = setup(t);
  const id = run({
    ...base,
    slug: "gated",
    nodes: [agent("a"), { id: "q", kind: "ask", question: "Which color?", choices: ["red", "blue"] }, { id: "ok", kind: "gate", check: "manual" }, agent("b")],
    edges: [{ from: "a", to: "q" }, { from: "q", to: "ok" }, { from: "ok", to: "b" }],
  });
  finish("a", "A");
  assert.equal(wf.detail(id).run.status, "needs_you");
  assert.deepEqual(wf.needs().map((n) => [n.kind, n.text, n.choices]), [["ask", "Which color?", ["red", "blue"]]]);
  assert.throws(() => wf.answer(id, { nodeId: "q", answer: "green" }, "user"), /one of: red, blue/);
  wf.answer(id, { nodeId: "q", answer: "blue" }, "user");
  assert.deepEqual(wf.needs().map((n) => n.kind), ["gate"]);
  assert.throws(() => wf.answer(id, { nodeId: "ok", approved: true }, "agent:bot"), /Only the user/);
  assert.equal(tasks().length, 1, "nothing runs past an open gate");
  wf.answer(id, { nodeId: "ok", approved: true }, "user");
  const b = tasks().find((x) => x.title === "Flow: b")!;
  assert.match(b.prompt, /Answers from the user:\n\nWhich color\?\nblue/);
  assert.equal(b.dependsOn.length, 1, "the handoff passes through the ask and gate to a");
  finish("b", "B");
  assert.equal(wf.detail(id).run.status, "succeeded");
});

test("a rejected manual gate fails the run", (t) => {
  const { wf, tasks, run } = setup(t);
  const id = run({ ...base, slug: "g", nodes: [{ id: "ok", kind: "gate", check: "manual" }, agent("b")], edges: [{ from: "ok", to: "b" }] });
  wf.answer(id, { nodeId: "ok", approved: false }, "user");
  assert.equal(wf.detail(id).run.status, "failed");
  assert.equal(tasks().length, 0);
});

test("parallel fans out one task per item, at most 20, then joins", (t) => {
  const { db, wf, tasks, run } = setup(t);
  assert.deepEqual(parseItems('["x", 2]'), ["x", "2"]);
  assert.deepEqual(parseItems("intro\n- one\n- two"), ["one", "two"]);
  const list = Array.from({ length: 25 }, (_, i) => `- file${i}`).join("\n");
  const id = run(
    {
      ...base,
      slug: "fan",
      inputs: [{ name: "files", label: "Files" }],
      nodes: [{ id: "each", kind: "agent", prompt: "Review {{item}}" }, { id: "all", kind: "parallel", over: "files", node: "each" }, agent("sum")],
      edges: [{ from: "all", to: "sum" }],
    },
    { files: list },
  );
  const children = tasks();
  assert.equal(children.length, 20);
  assert.equal(children[3]!.prompt.includes("Review file3"), true);
  for (const c of children) updateTask(db, c.id, { status: "done", result: c.title });
  wf.advance();
  const sum = tasks().find((x) => x.title === "Flow: sum")!;
  assert.equal(sum.dependsOn.length, 0, "the joined output goes in the prompt, not 20 results");
  assert.match(sum.prompt, /Results of "all":\n\nFlow: each 1\n\nFlow: each 2/);
  assert.equal(wf.detail(id).run.status, "running");
});

test("a FAIL check stops the run; resume runs it again", (t) => {
  const { wf, tasks, finish, run } = setup(t);
  const id = run({
    ...base,
    slug: "check",
    nodes: [agent("a"), { id: "types", kind: "gate", check: "typecheck" }, agent("b")],
    edges: [{ from: "a", to: "types" }, { from: "types", to: "b" }],
  });
  finish("a", "A");
  finish("types", "Ran tsc.\nFAIL: 3 errors");
  const { run: r } = wf.detail(id);
  assert.equal(r.status, "failed");
  assert.match(r.error!, /types: Check failed: FAIL: 3 errors/);
  assert.ok(!tasks().some((x) => x.title === "Flow: b"));
  wf.resume(id);
  assert.equal(tasks().filter((x) => x.title === "Flow: types").length, 2, "a new check task; a stays done");
  assert.equal(wf.detail(id).run.status, "running");
});

test("cancel cancels the run's queued tasks", async (t) => {
  const { db, wf, tasks, run } = setup(t);
  const id = run({ ...base, slug: "two", nodes: [agent("a"), agent("b")] });
  assert.equal(tasks().length, 2);
  const detail = await wf.cancel(id);
  assert.equal(detail.run.status, "cancelled");
  assert.ok(detail.steps.every((s) => s.status === "cancelled"));
  assert.ok(tasks().every((x) => getTask(db, x.id)!.status === "cancelled"));
  await assert.rejects(wf.cancel(id), /run is cancelled/);
});

test("an agent-started run waits for approval before its first task", (t) => {
  const { wf, tasks, run } = setup(t);
  const id = run({ ...base, slug: "agentic", nodes: [agent("a")] }, undefined, "agent:bot");
  assert.equal(wf.detail(id).run.status, "pending_approval");
  assert.equal(tasks().length, 0);
  assert.deepEqual(wf.needs().map((n) => n.kind), ["run_approval"]);
  assert.throws(() => wf.approve(id, undefined), /runtimeMode is required/);
  wf.approve(id, "approval-required");
  const [task] = tasks();
  assert.equal(task!.source, "agent:bot");
  assert.equal(task!.status, "queued");
  assert.equal(task!.runtimeMode, "approval-required");
});

test("agent tools only see their own runs and cannot set a runtime mode", async (t) => {
  const { wf, run } = setup(t);
  const tool = (name: string) => wf.tools.find((x) => x.name === name)!;
  const own = run({ ...base, slug: "mine", nodes: [agent("a")] }, undefined, "agent:bot");
  assert.throws(() => tool("workflow_status").handler({ run_id: own }, "other"), /Run not found/);
  assert.equal((tool("workflow_status").handler({ run_id: own }, "bot") as { status: string }).status, "pending_approval");
  const started = tool("workflow_run").handler({ slug: "mine", project: "p1", inputs: {} }, "bot") as { id: string; status: string };
  assert.equal(started.status, "pending_approval");
});

test("worktree steps get their own branch; checks after them run in that worktree", (t) => {
  const rows: ThreadRow[] = [];
  const { db, tasks, finish, run } = setup(t, () => rows);
  run({
    ...base,
    slug: "wt",
    nodes: [{ ...agent("fix"), worktree: true }, { id: "tests", kind: "gate", check: "tests" }],
    edges: [{ from: "fix", to: "tests" }],
  });
  const fix = tasks()[0]!;
  assert.equal(fix.workspace.type, "worktree");
  assert.match((fix.workspace as { branch: string }).branch, /^wf\/wt-fix-[0-9a-f]{8}$/);
  updateTask(db, fix.id, { threadId: "th1" });
  rows.push({ machineId: "m1", id: "th1", worktreePath: "/repo/.wt/fix" } as unknown as ThreadRow);
  finish("fix", "fixed");
  assert.deepEqual(tasks().find((x) => x.title === "Flow: tests")!.workspace, { type: "existing_worktree", worktreePath: "/repo/.wt/fix" });
});

test("the verdict is the first PASS/FAIL line, so a long reply cut at 4000 characters keeps it", () => {
  const long = `PASS\n${"test output line\n".repeat(400)}`.slice(0, 4000);
  assert.equal(checkPassed(long), true);
  assert.equal(checkPassed("Ran the suite.\nFAIL: 2 tests broke\nPASS later"), false);
  assert.equal(checkPassed("no verdict"), false);
});

test("commands pulse; a cancel T3 could not interrupt says so and blocks resume", async (t) => {
  const { db, dispatcher, wf, tasks, run, changes } = setup(t);
  const id = run({ ...base, slug: "stuck", nodes: [agent("a")] });
  assert.ok(changes() > 0, "start pulses");
  const [task] = tasks();
  updateTask(db, task!.id, { status: "running" });
  dispatcher.cancel = async () => {
    throw new T3Error("fail", "interrupt timed out");
  };
  await assert.rejects(wf.cancel(id), /1 running step could not be interrupted/);
  assert.match(wf.detail(id).run.error!, /could not be interrupted/);
  assert.throws(() => wf.resume(id), /still running/);
  updateTask(db, task!.id, { status: "cancelled" });
  wf.resume(id);
  assert.equal(tasks().length, 2);
});

test("import says when the project has no .t3/workflows folder", async (t) => {
  const listEntries = async (_cwd: string, dir: string) => {
    if (dir !== "") throw new T3Error("fail", "Failed to list workspace entries");
    return [{ path: "src", kind: "directory" as const }];
  };
  const link = { state: { status: "online" }, listEntries, readFile: async () => ({ contents: "", truncated: false }) };
  const { wf } = setup(t, () => [], () => link as never);
  const route = wf.routes.find((r) => r.path === "/api/workflows/import")!;
  await assert.rejects(Promise.resolve(route.handler({ body: { machineId: "m1", projectId: "p1" } } as never)), /No \.t3\/workflows folder/);
});
