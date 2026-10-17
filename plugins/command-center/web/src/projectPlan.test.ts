import assert from "node:assert/strict";
import test from "node:test";
import { planMilestones, planTodos } from "./projectPlan.ts";
import type { MemoryEntry } from "../../server/memory.ts";
import type { Section } from "../../server/sections.ts";

test("project checklist keeps scope, completed tasks and section filters independent", () => {
  const entries = [
    { id: "1", projectId: "p", kind: "todo", text: "Validar datos", done: false, sectionId: "s" },
    { id: "2", projectId: "p", kind: "todo", text: "Crear API", done: true, sectionId: null },
    { id: "3", projectId: "other", kind: "todo", text: "Validar datos", done: false },
    { id: "4", projectId: "p", kind: "progress", text: "Validar datos", done: false },
  ] as MemoryEntry[];
  assert.deepEqual(planTodos(entries, "p", "open", "VALIDAR", "s").map((e) => e.id), ["1"]);
  assert.deepEqual(planTodos(entries, "p", "done", "", "none").map((e) => e.id), ["2"]);
  assert.equal(planTodos(entries, "p", "all", "", "").length, 2);
  assert.equal(planTodos(entries, "p", "open", "", "none").length, 0);
});

test("milestones count completed phases rather than implying whole-product completion", () => {
  const sections = [
    { projectId: "p", status: "done", blocker: null },
    { projectId: "p", status: "review", blocker: "Decisión de negocio" },
    { projectId: "p", status: "blocked", blocker: null },
    { projectId: "other", status: "done", blocker: null },
  ] as Section[];
  const result = planMilestones(sections, "p");
  assert.equal(result.done, 1);
  assert.equal(result.sections.length, 3);
  assert.equal(result.blocked.length, 2);
});
