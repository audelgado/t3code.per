import assert from "node:assert/strict";
import test from "node:test";
import { isMessageSubmitKey } from "./messageComposer.ts";

const enter = { key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };

test("Enter envía y Mayús+Enter permite escribir mensajes de varias líneas", () => {
  assert.equal(isMessageSubmitKey(enter), true);
  assert.equal(isMessageSubmitKey({ ...enter, shiftKey: true }), false);
  assert.equal(isMessageSubmitKey({ ...enter, key: "a" }), false);
});

test("confirmar una composición IME o utilizar otro atajo no envía el mensaje", () => {
  assert.equal(isMessageSubmitKey({ ...enter, isComposing: true }), false);
  assert.equal(isMessageSubmitKey({ ...enter, keyCode: 229 }), false);
  for (const modifier of ["altKey", "ctrlKey", "metaKey"] as const) assert.equal(isMessageSubmitKey({ ...enter, [modifier]: true }), false);
});
