import assert from "node:assert/strict";
import test from "node:test";
import { insertAtCaret } from "./dictation.ts";

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
