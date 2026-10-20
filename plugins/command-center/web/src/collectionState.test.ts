import assert from "node:assert/strict";
import test from "node:test";
import { collectionHash, readCollectionState } from "./collectionState.ts";
import { parseRoute, hashes } from "./navigation.ts";
import { paginateCollection } from "./pagination.ts";

const defaults = { query: "", machineId: "", status: "all" };

test("los filtros se comparten sin perder la ruta, el proyecto ni su pesta\u00f1a", () => {
  const base = hashes.project("equipo:proyecto/uno", "memory");
  const filters = { query: "dise\u00f1o & API? #uno", machineId: "remoto", status: "online" };
  const filtered = collectionHash(base, "projects.filters", filters, defaults);
  const paged = collectionHash(filtered, "memory.page", 3, 1);
  assert.deepEqual(parseRoute(paged), parseRoute(base));
  assert.deepEqual(readCollectionState(paged, "projects.filters", defaults), filters);
  assert.equal(readCollectionState(paged, "memory.page", 1), 3);
  const cleared = collectionHash(paged, "projects.filters", defaults, defaults);
  assert.equal(readCollectionState(cleared, "memory.page", 1), 3);
  assert.equal(new URLSearchParams(cleared.split("?")[1]).get("tab"), "memory");
  assert.equal(collectionHash(base, "memory.page", 1, 1), base);
});

test("los estados de historial restauran b\u00fasqueda y p\u00e1gina y conservan enlaces de tareas", () => {
  const base = hashes.task("tarea&uno");
  const first = collectionHash(base, "work.filters", defaults, defaults);
  const second = collectionHash(first, "work.filters", { ...defaults, query: "buscar" }, defaults);
  const third = collectionHash(second, "work.page", 4, 1);
  for (const hash of [first, second, third, second, first]) assert.equal(parseRoute(hash).taskId, "tarea&uno");
  assert.equal(readCollectionState(second, "work.filters", defaults).query, "buscar");
  assert.equal(readCollectionState(second, "work.page", 1), 1);
  assert.deepEqual(readCollectionState(first, "work.filters", defaults), defaults);
});

test("valores inv\u00e1lidos o incompletos vuelven al filtro seguro", () => {
  for (const value of ["invalid", "null", "[]", '{"query":"x"}', '{"query":1,"machineId":"","status":"all"}']) {
    assert.deepEqual(readCollectionState(`#projects?filter=${encodeURIComponent(value)}`, "filter", defaults), defaults);
  }
  for (const value of [0, -2, 1.5, 1e20, "2", null]) {
    assert.equal(readCollectionState(collectionHash("#work", "page", value, 1), "page", 1), 1);
  }
  const invalidTab = collectionHash("#money", "tab", "other", "income");
  assert.equal(readCollectionState(invalidTab, "tab", "income", (v) => ["income", "costs"].includes(v)), "income");
});

test("artefacto y versi\u00f3n sobreviven a recarga, sin desplazar filtros ni rutas antiguas", () => {
  for (const base of ["#projects/artifacts", "#artifacts", hashes.project("m:p", "artifacts")]) {
    const open = collectionHash(base, "artifacts.open", "artifact/one", null);
    const version = collectionHash(open, "artifacts.version", "3", "");
    assert.deepEqual(parseRoute(version), parseRoute(base));
    assert.equal(readCollectionState<string | null>(version, "artifacts.open", null), "artifact/one");
    assert.equal(readCollectionState(version, "artifacts.version", ""), "3");
  }
});

test("paginar un historial cargado limita las filas sin perder resultados al retroceder", () => {
  const entries = Array.from({ length: 10003 }, (_, id) => ({ id }));
  const seen = [];
  for (let page = 1; page <= Math.ceil(entries.length / 25); page++) {
    const result = paginateCollection(entries, page, 25);
    assert.ok(result.items.length <= 25);
    seen.push(...result.items);
  }
  assert.deepEqual(seen, entries);
  assert.deepEqual(paginateCollection(entries, 2, 25).items, entries.slice(25, 50));
});
