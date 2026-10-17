import assert from "node:assert/strict";
import test from "node:test";
import { validateThreadAnswers } from "./threadAnswers.ts";
import type { UserInputQuestion } from "./types.ts";

const q: UserInputQuestion = { id: "destination", header: "Sistema", question: "¿Dónde?", options: [{ label: "VPS", description: "Remoto", value: "vps:tayna" }], allowCustomAnswer: false };
test("answers keep provider values and validate required, optional and multiple choices", () => {
  assert.deepEqual(validateThreadAnswers([q], { destination: "vps:tayna" }), { destination: "vps:tayna" });
  assert.throws(() => validateThreadAnswers([q], { destination: "VPS" }), /Elegí/);
  assert.throws(() => validateThreadAnswers([q], {}), /Respondé/);
  assert.throws(() => validateThreadAnswers([q], { old: "x" }), /cambiaron/);
  assert.deepEqual(validateThreadAnswers([{ ...q, required: false }], {}), {});
  assert.deepEqual(validateThreadAnswers([{ ...q, multiSelect: true }], { destination: ["vps:tayna"] }), { destination: ["vps:tayna"] });
  assert.throws(() => validateThreadAnswers([q], { destination: ["vps:tayna"] }), /válidas/);
});
test("free text and editable initial answers preserve whitespace and explicit empty answers", () => {
  const edit = { ...q, options: [], allowCustomAnswer: true, initialAnswer: "Texto inicial" };
  assert.deepEqual(validateThreadAnswers([edit], { destination: "  Texto modificado\n" }), { destination: "  Texto modificado\n" });
  assert.deepEqual(validateThreadAnswers([edit], { destination: "" }), { destination: "" });
  assert.throws(() => validateThreadAnswers([{ ...edit, initialAnswer: undefined }], { destination: "" }), /Respondé/);
});
