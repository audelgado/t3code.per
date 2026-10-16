import assert from "node:assert/strict";
import test from "node:test";
import type { TaskStatus } from "../../server/types.ts";
import { PROJECT_PALETTE, ago, priorityLabel, projectColor, runtimeModeLabel, stageLabel, statusTone } from "./look.ts";

test("project colours are stable and come from the palette", () => {
  assert.equal(projectColor("m1:p1"), projectColor("m1:p1"));
  assert.ok(PROJECT_PALETTE.includes(projectColor("m1:p2") as (typeof PROJECT_PALETTE)[number]));
  assert.ok(new Set(Array.from({ length: 40 }, (_, i) => projectColor(`m:${i}`))).size > 4);
});

test("task statuses use the shared Spanish glossary", () => {
  const labels: Record<TaskStatus, string> = {
    pending_approval: "Por aprobar", queued: "En cola", starting: "Iniciando", running: "En curso", waiting: "Esperando",
    needs_you: "Te necesita", done: "Listo", failed: "Falló", cancelled: "Cancelada",
  };
  for (const [status, label] of Object.entries(labels)) assert.equal(statusTone(status as TaskStatus).label, label);
  assert.equal(statusTone("needs_you").fg, "#b45309");
});

test("priority, stage and runtime labels clamp and fall back", () => {
  assert.deepEqual([2, 0, -2, 9].map(priorityLabel), ["Urgente", "Normal", "Mínima", "Urgente"]);
  assert.deepEqual([0, 4, 6, 99].map(stageLabel), ["Creada", "PR abierto", "Limpieza", "Limpieza"]);
  assert.equal(runtimeModeLabel("auto-accept-edits"), "Aceptar ediciones");
  assert.equal(runtimeModeLabel(null), "Sin definir");
});

test("relative time is Spanish", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assert.equal(ago("2026-10-16T11:59:30Z", now), "ahora");
  assert.equal(ago("2026-10-16T11:55:00Z", now), "hace 5 min");
  assert.equal(ago("2026-10-14T12:00:00Z", now), "hace 2 días");
  assert.equal(ago(null, now), "");
});
