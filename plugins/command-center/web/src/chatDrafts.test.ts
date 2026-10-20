import assert from "node:assert/strict";
import test from "node:test";
import { createChatDraftStore } from "./chatDrafts.ts";

function storage() {
  const rows = new Map<string, string>();
  return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); }, removeItem: (key: string) => { rows.delete(key); } };
}

test("restaura borradores por proyecto, compositor y alcance al volver o recargar", () => {
  const session = storage();
  const drafts = createChatDraftStore(() => session);
  drafts.write("project-chat:machine:a", "Primer proyecto");
  drafts.write("project-chat:machine:b", "Segundo proyecto");
  drafts.write("assistant:global", "Consulta global");
  drafts.write("project-request:machine:a", "Nuevo pedido");
  assert.equal(drafts.read("project-chat:machine:a"), "Primer proyecto");
  assert.equal(drafts.read("assistant:project:a"), "");
  const restored = createChatDraftStore(() => session);
  assert.equal(restored.read("project-chat:machine:b"), "Segundo proyecto");
  assert.equal(restored.read("project-request:machine:a"), "Nuevo pedido");
  assert.equal(restored.read("assistant:global"), "Consulta global");
});

test("solo limpia el borrador enviado y conserva ediciones posteriores y otros destinos", async () => {
  const session = storage();
  const drafts = createChatDraftStore(() => session);
  drafts.write("a", "Pedido");
  drafts.write("b", "Otro destino");
  const send = async (succeed: boolean) => {
    const sent = drafts.read("a");
    await (succeed ? Promise.resolve() : Promise.reject(new Error("Sin conexión")));
    drafts.clearSent("a", sent);
  };
  await assert.rejects(send(false));
  assert.equal(drafts.read("a"), "Pedido");
  drafts.write("a", "Nueva edición");
  drafts.clearSent("a", "Pedido");
  assert.equal(drafts.read("a"), "Nueva edición");
  await send(true);
  assert.equal(createChatDraftStore(() => session).read("a"), "");
  assert.equal(drafts.read("b"), "Otro destino");
});

test("conserva los borradores en memoria si falla el acceso al almacenamiento", () => {
  for (const getStorage of [() => { throw new Error("Bloqueado"); }, () => ({ getItem: () => { throw new Error("Lectura"); }, setItem: () => { throw new Error("Cuota"); }, removeItem: () => { throw new Error("Borrado"); } })]) {
    const drafts = createChatDraftStore(getStorage);
    assert.equal(drafts.read("a"), "");
    drafts.write("a", "Pedido conservado");
    assert.equal(drafts.read("a"), "Pedido conservado");
    drafts.clearSent("a", "Pedido conservado");
    assert.equal(drafts.read("a"), "");
  }
});
