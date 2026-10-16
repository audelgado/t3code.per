import assert from "node:assert/strict";
import test from "node:test";
import { navigationKeys, resolveShortcut, visibleNavigation } from "./navigation.ts";

test("each destination requires a fresh g prefix, and interrupted sequences expire", () => {
  for (const [key, route] of Object.entries(navigationKeys)) {
    assert.equal(resolveShortcut({ key }, null, 100).action, undefined);
    const prefix = resolveShortcut({ key: "g" }, null, 100);
    assert.deepEqual(resolveShortcut({ key }, prefix.prefixAt, 200), { prefixAt: null, action: { type: "navigate", route } });
    assert.equal(resolveShortcut({ key }, prefix.prefixAt, 1601).action, undefined);
  }
  assert.deepEqual(resolveShortcut({ key: "x" }, 100, 150), { prefixAt: null });
  assert.deepEqual(resolveShortcut({ key: "Escape" }, 100, 150), { prefixAt: null });
});

test("editing, dialogs, dictation, repeated keys and modifiers neither navigate nor keep a prefix", () => {
  for (const context of [
    { editable: true }, { dialogOpen: true }, { isComposing: true }, { repeat: true },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { defaultPrevented: true },
  ]) {
    for (const key of ["g", "h", "/"]) assert.deepEqual(resolveShortcut({ key, ...context }, 100, 150), { prefixAt: null });
  }
  for (const context of [{ editable: true }, { dialogOpen: true }, { isComposing: true }, { repeat: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.equal(resolveShortcut({ key: "?", ...context }, null, 100).action, undefined);
  }
});

test("search and help work without a prefix, including the shifted question mark", () => {
  assert.deepEqual(resolveShortcut({ key: "/" }, null, 100).action, { type: "search" });
  assert.deepEqual(resolveShortcut({ key: "?", shiftKey: true }, null, 100).action, { type: "help" });
  assert.equal(resolveShortcut({ key: "H", shiftKey: true }, 100, 150).action, undefined);
});

test("desktop and More share all grouped destinations and only gate Orca", () => {
  const groups = visibleNavigation(false);
  assert.deepEqual(groups.map((group) => group.label), ["Workspace", "Business", "System"]);
  const routes = groups.flatMap((group) => group.items.map((item) => item.route));
  assert.deepEqual(routes, ["home", "ask", "queue", "work", "projects", "workflows", "memory", "artifacts", "sections", "finance", "profiles", "infra", "machines", "agents", "notifications"]);
  assert.equal(new Set(routes).size, routes.length);
  for (const route of Object.values(navigationKeys)) assert.ok(routes.includes(route));
  assert.deepEqual(visibleNavigation(true).flatMap((group) => group.items.map((item) => item.route)).filter((route) => !routes.includes(route)), ["orca"]);
});
