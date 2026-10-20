import assert from "node:assert/strict";
import { test } from "node:test";
import { sectionProgress } from "./sectionProgress.ts";
import { createExclusiveAction } from "./sectionMutation.ts";
import { readDraft, writeDraft, clearDraft } from "./sectionDraft.ts";

test("el progreso conserva una escala válida y distingue un total desconocido", () => {
  assert.deepEqual(sectionProgress(4, 0), { max: undefined, now: undefined, percent: 0 });
  assert.deepEqual(sectionProgress(9, 3), { max: 3, now: 3, percent: 100 });
  assert.deepEqual(sectionProgress(-1, 3), { max: 3, now: 0, percent: 0 });
  assert.deepEqual(sectionProgress(1, 4), { max: 4, now: 1, percent: 25 });
});

test("una creación pendiente ignora envíos repetidos y permite reintentar tras un fallo", async () => {
  const submit = createExclusiveAction();
  let calls = 0;
  let reject!: (error: Error) => void;
  const pending = submit(async () => { calls++; await new Promise<void>((_, fail) => { reject = fail; }); });
  const failure = assert.rejects(pending, /fallo/);
  await submit(async () => { calls++; });
  assert.equal(calls, 1);
  reject(new Error("fallo"));
  await failure;
  await submit(async () => { calls++; });
  assert.equal(calls, 2);
});

test("los borradores sobreviven al cierre, se eliminan al guardar y toleran almacenamiento inválido", (t) => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  t.after(() => { if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else Reflect.deleteProperty(globalThis, "sessionStorage"); });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  writeDraft("section:a", { name: "Borrador" });
  assert.deepEqual(readDraft("section:a", { name: "Original" }), { name: "Borrador" });
  assert.equal(readDraft("section:a", "JSON"), "JSON");
  values.set("section:a", "null");
  assert.deepEqual(readDraft("section:a", { name: "Original" }), { name: "Original" });
  writeDraft("flow:a", "{ sin terminar");
  assert.equal(readDraft("flow:a", ""), "{ sin terminar");
  clearDraft("flow:a");
  assert.equal(readDraft("flow:a", "original"), "original");
});
