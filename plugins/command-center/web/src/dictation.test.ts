import assert from "node:assert/strict";
import test from "node:test";
import { insertAtCaret, recognitionTranscript } from "./dictation.ts";

const phrase = (text: string, isFinal = true) => ({ isFinal, 0: { transcript: text } });

test("cumulative and replayed final results are inserted once, without suppressing deliberate repetitions", () => {
  const consume = recognitionTranscript();
  assert.deepEqual(consume([phrase("hola")]), { final: "hola", interim: "" });
  assert.deepEqual(consume([phrase("hola"), phrase("mundo", false)]), { final: "", interim: "mundo" });
  assert.deepEqual(consume([phrase("hola"), phrase("mundo")]), { final: "mundo", interim: "" });
  assert.deepEqual(consume([phrase("hola"), phrase("mundo")]), { final: "", interim: "" });
  assert.equal(consume([phrase("hola"), phrase("mundo"), phrase("mundo")]).final, "mundo");
});

test("interim revisions replace the preview; stop only needs the remaining uncommitted words", () => {
  const consume = recognitionTranscript();
  assert.deepEqual(consume([phrase("quiero", false)]), { final: "", interim: "quiero" });
  assert.deepEqual(consume([phrase("quiero ordenar", false)]), { final: "", interim: "quiero ordenar" });
  assert.deepEqual(consume([phrase("quiero ordenar"), phrase("el proyecto", false)]), { final: "quiero ordenar", interim: "el proyecto" });
  assert.deepEqual(consume([phrase("quiero ordenar"), phrase("el proyecto")]), { final: "el proyecto", interim: "" });
  assert.equal(recognitionTranscript()([phrase("quiero ordenar")]).final, "quiero ordenar");
});

test("insertAtCaret adds spaces only where words would touch", () => {
  assert.deepEqual(insertAtCaret("hola", 4, 4, "mundo"), { value: "hola mundo", caret: 10 });
  assert.deepEqual(insertAtCaret("hola ", 5, 5, "mundo"), { value: "hola mundo", caret: 10 });
  assert.deepEqual(insertAtCaret("hola chau", 4, 4, "mundo"), { value: "hola mundo chau", caret: 10 });
});

test("insertAtCaret keeps punctuation attached and ignores empty phrases", () => {
  assert.equal(insertAtCaret("hola", 4, 4, ", mundo").value, "hola, mundo");
  assert.deepEqual(insertAtCaret("hola", 2, 2, "  "), { value: "hola", caret: 2 });
});

test("insertAtCaret replaces the selection", () => {
  assert.equal(insertAtCaret("hola mundo", 5, 10, "todos").value, "hola todos");
});
