import assert from "node:assert/strict";
import test from "node:test";
import type { ProfileInput } from "../../server/profiles.ts";
import { createCollectionDraftStore } from "./collectionDrafts.ts";
import { isProfileDraft } from "./profileDraft.ts";

test("restaura todos los cambios del perfil al elegir Sin definir en cualquier campo opcional", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const original: ProfileInput = { name: "Revisor", avatar: "", rolePrompt: "Original", model: { instanceId: "codex", model: "modelo" }, runtimeMode: "full-access", interactionMode: "plan" };
  for (const field of ["model", "runtimeMode", "interactionMode"] as const) {
    const changed = { ...original, rolePrompt: "Indicaciones sin guardar", [field]: null };
    createCollectionDraftStore(() => storage).write("profile.a", changed);
    assert.deepEqual(createCollectionDraftStore(() => storage).read("profile.a", original, isProfileDraft), changed);
  }
  const empty: ProfileInput = { ...original, model: null, runtimeMode: null, interactionMode: null };
  createCollectionDraftStore(() => storage).write("profile.a", original);
  assert.deepEqual(createCollectionDraftStore(() => storage).read("profile.a", empty, isProfileDraft), original);
});

test("rechaza perfiles incompatibles sin convertir la forma del valor original en un requisito", () => {
  for (const value of [null, [], { name: 1 }, { name: "Perfil", model: "codex" }, { name: "Perfil", model: { model: "x" } }, { name: "Perfil", runtimeMode: "otro" }, { name: "Perfil", interactionMode: false }]) assert.equal(isProfileDraft(value), false);
  assert.equal(isProfileDraft({ name: "" }), true);
  assert.equal(isProfileDraft({ name: "Perfil", model: null, runtimeMode: null, interactionMode: null }), true);
});
