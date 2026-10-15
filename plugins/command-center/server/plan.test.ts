import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listTasks, openDb, replaceProjects } from "./db.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createPlan, PlanError, splitRequest } from "./plan.ts";

test("splitRequest splits on punctuation and English or Spanish connectives", () => {
  assert.deepEqual(splitRequest("Fix the login page, add tests and update docs"), ["Fix the login page", "add tests", "update docs"]);
  assert.deepEqual(splitRequest("Armar la API y conectar el front; revisar"), ["Armar la API", "conectar el front", "revisar"]);
});

test("splitRequest keeps ordered work in one step and words that contain a connective", () => {
  assert.deepEqual(splitRequest("Write the migration and then run it, update docs"), ["Write the migration and then run it", "update docs"]);
  assert.deepEqual(splitRequest("Armar la API y luego conectar el front"), ["Armar la API y luego conectar el front"]);
  assert.deepEqual(splitRequest("Update the android brand theme"), ["Update the android brand theme"]);
  assert.deepEqual(splitRequest("  ,  and "), []);
});

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-plan-"));
  const db = openDb(home);
  replaceProjects(db, "m1", [{ machineId: "m1", id: "p1", title: "App", workspaceRoot: "/srv/app", defaultModel: null, updatedAt: "2026-10-15T00:00:00.000Z" }]);
  const dispatcher = new Dispatcher({ db, link: () => undefined });
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { db, dispatcher, base: { machineId: "m1", projectId: "p1" } };
}

test("createPlan chains steps by dependsOn; steps without `after` share only the external deps", async (t) => {
  const { dispatcher, base } = setup(t);
  const root = dispatcher.createTask({ ...base, prompt: "existing" }, "user");
  const plan = await createPlan(
    dispatcher,
    {
      ...base,
      request: "a, b, c, d",
      dependsOn: [root.id],
      steps: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c", after: [0, 1] }, { prompt: "d", after: [2] }],
    },
    "user",
  );
  assert.deepEqual(plan.map((p) => p.dependsOn), [[root.id], [root.id], [root.id, plan[0]!.id, plan[1]!.id], [root.id, plan[2]!.id]]);
  assert.equal(plan[0]!.title, "a");
  assert.match(plan[0]!.prompt, /^a\n\nFull request, for context only:\na, b, c, d$/);
});

test("createPlan with one step adds no context and agent plans wait for approval", async (t) => {
  const { dispatcher, base } = setup(t);
  const [task] = await createPlan(dispatcher, { ...base, request: "x", steps: [{ prompt: "x" }] }, "agent:hermes");
  assert.equal(task!.prompt, "x");
  assert.equal(task!.status, "pending_approval");
});

test("createPlan rejects bad steps, and cancels created tasks when a later one is refused", async (t) => {
  const { db, dispatcher, base } = setup(t);
  await assert.rejects(createPlan(dispatcher, { ...base, steps: [] }, "user"), PlanError);
  await assert.rejects(createPlan(dispatcher, { ...base, steps: [{ prompt: "a", after: [0] }] }, "user"), PlanError);
  await assert.rejects(createPlan(dispatcher, { ...base, steps: [{ prompt: "  " }] }, "user"), PlanError);
  // The second step is refused by createTask (unknown project), so the first must not survive.
  await assert.rejects(
    createPlan(dispatcher, { ...base, steps: [{ prompt: "a" }, { prompt: "b" }] }, "user", (task) =>
      task.prompt.startsWith("b") ? { ...task, projectId: "nope" } : task,
    ),
  );
  assert.deepEqual(listTasks(db).map((x) => x.status), ["cancelled"]);
});
