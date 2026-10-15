import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as db from "./db.ts";
import type { Machine, Task } from "./types.ts";

const posix = process.platform !== "win32";
const now = "2026-10-15T00:00:00.000Z";

/** Temp CC_HOME and an open DB; the DB closes before the dir is removed (Windows holds open files). */
function setup(t: { after(fn: () => void): void }) {
  const h = mkdtempSync(join(tmpdir(), "cc-db-"));
  const d = db.openDb(h);
  t.after(() => {
    if (d.isOpen) d.close();
    rmSync(h, { recursive: true, force: true });
  });
  return { h, d };
}

const task: Task = {
  id: "t1",
  title: "Fix it",
  prompt: "Fix the bug",
  machineId: "env-1",
  projectId: "p1",
  model: { instanceId: "codex", model: "gpt-5", options: [{ id: "effort", value: "high" }] },
  runtimeMode: null,
  interactionMode: "default",
  workspace: { type: "worktree", baseRef: "main", startFromOrigin: true },
  priority: 1,
  dependsOn: ["t0"],
  source: "agent:hermes",
  status: "pending_approval",
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

test("reopen is idempotent, WAL is active, files are private", (t) => {
  const { h, d: first } = setup(t);
  first.close();
  const d = db.openDb(h);
  try {
    assert.equal(d.prepare("pragma journal_mode").get()?.journal_mode, "wal");
    assert.equal(d.prepare("pragma busy_timeout").get()?.timeout, 5000);
  } finally {
    d.close();
  }
  if (posix) {
    assert.equal(statSync(h).mode & 0o777, 0o700);
    assert.equal(statSync(join(h, "cc.sqlite")).mode & 0o777, 0o600);
  }
});

test("a task round-trips with JSON columns and patches", (t) => {
  const { d } = setup(t);
  db.insertTask(d, task);
  assert.deepEqual(db.getTask(d, "t1"), task);
  const next = db.updateTask(d, "t1", { status: "queued", runtimeMode: "auto-accept-edits", dependsOn: [] });
  assert.equal(next.status, "queued");
  assert.equal(next.runtimeMode, "auto-accept-edits");
  assert.deepEqual(next.dependsOn, []);
  assert.deepEqual(next.workspace, task.workspace);
  assert.notEqual(next.updatedAt, now);
  assert.deepEqual(db.listTasks(d, ["queued"]).map((x) => x.id), ["t1"]);
  assert.deepEqual(db.listTasks(d, ["done"]), []);
  assert.equal(db.getTask(d, "missing"), undefined);
});

test("machines, project cache and kv", (t) => {
  const { h, d } = setup(t);
  const m: Machine = {
    id: "env-1",
    label: "VPS",
    apiUrl: "https://vps.example.ts.net",
    webUrl: null,
    maxConcurrent: 2,
    enabled: true,
    serverVersion: null,
    tokenExpiresAt: null,
    createdAt: now,
  };
  db.upsertMachine(d, m);
  db.upsertMachine(d, { ...m, label: "VPS 2" });
  assert.deepEqual(db.listMachines(d), [{ ...m, label: "VPS 2" }]);
  db.updateMachine(d, "env-1", { enabled: false, serverVersion: "1.2.3" });
  assert.equal(db.getMachine(d, "env-1")?.enabled, false);

  const p = { machineId: "env-1", id: "p1", title: "App", workspaceRoot: "/srv/app", defaultModel: null, updatedAt: now };
  db.replaceProjects(d, "env-1", [p, { ...p, id: "p2", defaultModel: { instanceId: "claude", model: "opus" } }]);
  db.replaceProjects(d, "env-1", [p]);
  assert.deepEqual(db.listProjects(d), [p]);
  assert.deepEqual(db.getProject(d, "env-1", "p1"), p);

  db.kvSet(d, "a", { x: 1 });
  db.kvSet(d, "a", { x: 2 });
  assert.deepEqual(db.kvGet(d, "a"), { x: 2 });

  db.writeToken(h, "env-1", "tok");
  db.deleteMachine(d, h, "env-1");
  assert.equal(db.getMachine(d, "env-1"), undefined);
  assert.deepEqual(db.listProjects(d), []);
  assert.equal(db.readToken(h, "env-1"), null);
});

test("tokens live in 0600 files, never in the DB", (t) => {
  const { h, d } = setup(t);
  const secret = "SENTINEL-t3-token-0123456789";
  db.writeToken(h, "env-1", `${secret}\n`);
  assert.equal(db.readToken(h, "env-1"), secret);
  if (posix) assert.equal(statSync(join(h, "tokens", "env-1")).mode & 0o777, 0o600);
  d.exec("pragma wal_checkpoint(truncate)");
  d.close();
  assert.ok(!readFileSync(join(h, "cc.sqlite")).includes(secret));
  assert.throws(() => db.writeToken(h, "../escape", secret), /invalid machine id/);
  assert.throws(() => db.readToken(h, ".."), /invalid machine id/);
});
