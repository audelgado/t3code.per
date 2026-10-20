import assert from "node:assert/strict";
import test from "node:test";
import { createCollectionDraftStore } from "./collectionDrafts.ts";

const initial = { text: "", section: "" };
const draft = { text: "Revisar el resultado", section: "fase-1" };

function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test("el borrador sobrevive a desmontar y volver al proyecto con almacenamiento bloqueado", () => {
  const store = createCollectionDraftStore(() => { throw new Error("bloqueado"); });
  store.write("plan.a", draft);
  assert.deepEqual(store.read("plan.b", initial), initial);
  store.write("plan.b", { text: "Otro proyecto", section: "" });
  assert.deepEqual(store.read("plan.a", initial), draft);
  store.clear("plan.a");
  assert.deepEqual(store.read("plan.a", initial), initial);
  assert.equal(store.read("plan.b", initial).text, "Otro proyecto");
});

test("cuota llena nunca resucita la copia anterior y clear vacía ambos respaldos", () => {
  const disk = storage();
  const store = createCollectionDraftStore(() => disk);
  store.write("plan.a", { text: "Viejo", section: "" });
  disk.setItem = () => { throw new Error("cuota llena"); };
  store.write("plan.a", draft);
  assert.deepEqual(store.read("plan.a", initial), draft);
  disk.removeItem = () => { throw new Error("bloqueado"); };
  store.clear("plan.a");
  assert.deepEqual(store.read("plan.a", initial), initial);
  disk.removeItem = (key) => { disk.data.delete(key); };
  store.clear("plan.a");
  assert.deepEqual(createCollectionDraftStore(() => disk).read("plan.a", initial), initial);
});

test("recarga restaura texto y fase; JSON malformado o de tipos obsoletos usa el inicial", () => {
  const disk = storage();
  createCollectionDraftStore(() => disk).write("plan.a", draft);
  assert.deepEqual(createCollectionDraftStore(() => disk).read("plan.a", initial), draft);
  for (const raw of ["{", "null", "[]", '"texto"', '{"text":12,"section":""}', '{"text":"sin fase"}']) {
    disk.data.set("cc.draft.plan.a", raw);
    assert.deepEqual(createCollectionDraftStore(() => disk).read("plan.a", initial), initial);
  }
});

test("valida borradores anulables y listas sin aceptar contenido incompatible", () => {
  const disk = storage();
  disk.data.set("cc.draft.artifact", '{"title":12,"content":[]}');
  const accept = (value: unknown) => value === null || (typeof value === "object" && value !== null && "title" in value && typeof value.title === "string" && "content" in value && typeof value.content === "string");
  assert.equal(createCollectionDraftStore(() => disk).read("artifact", null, accept), null);
  disk.data.set("cc.draft.finance", '{"projectIds":[12]}');
  assert.deepEqual(createCollectionDraftStore(() => disk).read("finance", { projectIds: [] as string[] }), { projectIds: [] });
});

test("guardar y limpiar permite comenzar un borrador nuevo después de recargar", () => {
  const disk = storage();
  const store = createCollectionDraftStore(() => disk);
  store.write("plan.a", draft);
  store.clear("plan.a");
  assert.equal(disk.getItem("cc.draft.plan.a"), null);
  assert.deepEqual(store.read("plan.a", initial), initial);
  store.write("plan.a", { text: "Nuevo", section: "" });
  assert.equal(createCollectionDraftStore(() => disk).read("plan.a", initial).text, "Nuevo");
});
