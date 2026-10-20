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
    const sent = drafts.snapshot("a");
    await (succeed ? Promise.resolve() : Promise.reject(new Error("Sin conexión")));
    drafts.clearSent("a", sent);
  };
  await assert.rejects(send(false));
  assert.equal(drafts.read("a"), "Pedido");
  const sent = drafts.snapshot("a");
  drafts.write("a", "Nueva edición");
  drafts.clearSent("a", sent);
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
    drafts.clearSent("a", drafts.snapshot("a"));
    assert.equal(drafts.read("a"), "");
  }
});

test("reutiliza el ID tras un fallo y una recarga en cada compositor", async () => {
  const session = storage();
  const scopes = ["project-request:m:p", "project-chat:m:p", "thread:m:t", "assistant:global", "assistant:project:p"];
  const drafts = createChatDraftStore(() => session);
  const commands = new Set<string>();
  for (const scope of scopes) {
    drafts.write(scope, "Continuar");
    const sent = drafts.snapshot(scope);
    commands.add(sent.commandId);
    await assert.rejects(async () => {
      await Promise.reject(new Error("Respuesta perdida"));
      drafts.clearSent(scope, sent);
    });
    assert.deepEqual(drafts.snapshot(scope), sent);
    assert.deepEqual(createChatDraftStore(() => session).snapshot(scope), sent);
  }
  assert.equal(commands.size, scopes.length);
});

test("renueva el ID al editar incluso si el texto vuelve a ser el mismo", () => {
  const session = storage();
  const drafts = createChatDraftStore(() => session);
  const sent = drafts.write("a", "Continuar");
  drafts.write("a", "");
  const edited = drafts.write("a", "Continuar");
  assert.notEqual(edited.commandId, sent.commandId);
  drafts.clearSent("a", sent);
  assert.deepEqual(createChatDraftStore(() => session).snapshot("a"), edited);
  drafts.clearSent("a", edited);
  const cleared = createChatDraftStore(() => session).snapshot("a");
  assert.equal(cleared.text, "");
  assert.notEqual(cleared.commandId, edited.commandId);
  assert.notEqual(drafts.write("a", "Continuar").commandId, edited.commandId);
});

test("migra borradores de texto plano y conserva su ID en la siguiente recarga", () => {
  const session = storage();
  for (const text of ["Pedido anterior", '{"text":"Texto literal","commandId":"no es metadato"}', "cc.chat.draft.v1:incompleto"]) {
    session.setItem("cc.chat.draft:legacy", text);
    const migrated = createChatDraftStore(() => session).snapshot("legacy");
    assert.equal(migrated.text, text);
    assert.ok(migrated.commandId);
    assert.deepEqual(createChatDraftStore(() => session).snapshot("legacy"), migrated);
  }
});
