import assert from "node:assert/strict";
import test from "node:test";
import { isChatNearEnd } from "./chatScroll.ts";

test("sigue mensajes nuevos al estar cerca del final, también con contenido corto", () => {
  assert.equal(isChatNearEnd(500, 500, 1000), true);
  assert.equal(isChatNearEnd(404, 500, 1000), true);
  assert.equal(isChatNearEnd(0, 500, 200), true);
});

test("respeta la lectura de mensajes anteriores hasta que se vuelve al final", () => {
  assert.equal(isChatNearEnd(403, 500, 1000), false);
  assert.equal(isChatNearEnd(0, 500, 10000), false);
  assert.equal(isChatNearEnd(9500, 500, 10000), true);
});
