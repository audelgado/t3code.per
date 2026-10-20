import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeView, ThreadItem } from "../../server/types.ts";
import { createWorkflowRefresh, workflowSignal } from "./workflowRefresh.ts";

const empty: HomeView = { machines: [], queue: [], running: [], done: [], needsYou: [] };
test("las señales ignoran cambios globales y siguen tareas, aprobaciones y el proyecto de la ejecución", () => {
  assert.equal(workflowSignal(empty), workflowSignal({ ...empty, assistantVersion: 12 }));
  const thread = { key: "m:t", machineId: "m", projectId: "p", updatedAt: "1", status: "running" } as ThreadItem;
  const running = { ...empty, running: [thread] };
  assert.notEqual(workflowSignal(empty), workflowSignal(running));
  assert.notEqual(workflowSignal(running), workflowSignal({ ...running, running: [{ ...thread, updatedAt: "2" }] }));
  const scope = { machineId: "other", projectId: "p", id: "run" };
  assert.equal(workflowSignal(empty, scope), workflowSignal(running, scope));
  assert.notEqual(workflowSignal(empty, scope), workflowSignal({ ...empty, needsYou: [{ kind: "workflow", key: "approval", since: "1", runId: "run", title: "Flujo", text: "Aprobar" }] }, scope));
});

test("eventos repetidos limitan consultas conservando el respaldo y cambios relevantes inmediatos", () => {
  const refresh = createWorkflowRefresh();
  assert.equal(refresh("a", 0), true);
  for (let time = 1; time < 15_000; time += 100) assert.equal(refresh("a", time), false);
  assert.equal(refresh("a", 15_000), true);
  assert.equal(refresh("b", 15_001), true);
  assert.equal(refresh("b", 15_002), false);
});
