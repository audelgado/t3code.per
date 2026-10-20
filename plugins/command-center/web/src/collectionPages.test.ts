import assert from "node:assert/strict";
import test from "node:test";
import { collectCollectionPages, needsCollectionPage } from "./collectionPages.ts";
import { paginateCollection } from "./pagination.ts";

for (const size of [25, 30]) test(`historial: página 2, atrás, guardar y adelante recupera las filas (${size})`, async () => {
  const all = Array.from({ length: size * 3 }, (_, id) => ({ id: String(id) }));
  let requests = 0;
  const fetch = async (last: { id: string }) => {
    requests++;
    const offset = all.findIndex((item) => item.id === last.id) + 1;
    return { items: all.slice(offset, offset + size), hasMore: offset + size < all.length };
  };
  let cache = await collectCollectionPages([], { items: all.slice(0, size), hasMore: true }, () => 2 * size, fetch, () => true);
  assert.deepEqual(paginateCollection(cache.items, 2, size).items, all.slice(size, 2 * size));
  assert.equal(needsCollectionPage(cache.items.length, cache.hasMore, 1, size), false);
  // Guardar desde la página 1 reemplaza la lista por la primera página actualizada.
  cache = await collectCollectionPages([], { items: all.slice(0, size), hasMore: true }, () => size, fetch, () => true);
  assert.ok(needsCollectionPage(cache.items.length, cache.hasMore, 2, size));
  const firstMissing = await fetch(cache.items.at(-1)!);
  cache = await collectCollectionPages(cache.items, firstMissing, () => 2 * size, fetch, () => true);
  assert.equal(requests, 2);
  assert.deepEqual(paginateCollection(cache.items, 2, size).items, all.slice(size, 2 * size));
  assert.equal(needsCollectionPage(cache.items.length, cache.hasMore, 2, size), false);
});

test("detiene respuestas vacías o repetidas aunque anuncien más historial", async () => {
  for (const items of [[], [{ id: "a" }]]) {
    let requests = 0;
    const result = await collectCollectionPages([], { items: [{ id: "a" }], hasMore: true }, () => Number.MAX_SAFE_INTEGER,
      async () => { requests++; return { items, hasMore: true }; }, () => true);
    assert.equal(requests, 1);
    assert.deepEqual(result.items, [{ id: "a" }]);
    assert.equal(result.hasMore, false);
  }
});

test("una URL enorme tiene un límite de consultas y una petición obsoleta deja de recuperar", async () => {
  let requests = 0;
  const fetch = async () => ({ items: [{ id: String(++requests) }], hasMore: true });
  const result = await collectCollectionPages([], { items: [{ id: "0" }], hasMore: true }, () => Number.MAX_SAFE_INTEGER, fetch, () => true);
  assert.equal(result.items.length, 100);
  assert.equal(requests, 99);
  requests = 0;
  await collectCollectionPages([], { items: [{ id: "0" }], hasMore: true }, () => 1000, fetch, () => false);
  assert.equal(requests, 0);
});

test("un cambio de página durante la consulta usa el objetivo actual y elimina solapamientos", async () => {
  let target = 2;
  const result = await collectCollectionPages([], { items: [{ id: "a" }], hasMore: true }, () => target,
    async (last) => {
      if (last.id === "a") { target = 3; return { items: [{ id: "a" }, { id: "b" }], hasMore: true }; }
      return { items: [{ id: "b" }, { id: "c" }], hasMore: false };
    }, () => true);
  assert.deepEqual(result.items, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  assert.equal(result.hasMore, false);
});
