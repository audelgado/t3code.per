import assert from "node:assert/strict";
import test from "node:test";
import { navigationKeys, primaryNavigationRoutes, resolveShortcut, visibleNavigation } from "./navigation.ts";

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
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true },
  ]) {
    for (const shiftKey of [false, true]) {
      for (const key of ["g", "h", "/", "?"]) assert.deepEqual(resolveShortcut({ key, shiftKey, ...context }, 100, 150), { prefixAt: null });
    }
  }
});

test("search and help work without a prefix, including shifted punctuation", () => {
  assert.deepEqual(resolveShortcut({ key: "/" }, null, 100).action, { type: "search" });
  assert.deepEqual(resolveShortcut({ key: "?", shiftKey: true }, null, 100).action, { type: "help" });
  assert.deepEqual(resolveShortcut({ key: "/", shiftKey: true }, 100, 150), { prefixAt: null, action: { type: "search" } });
  for (const key of ["g", "h", "H"]) {
    assert.deepEqual(resolveShortcut({ key, shiftKey: true }, 100, 150), { prefixAt: null });
  }
});

test("shared navigation includes each destination once and only gates Orca", () => {
  const groups = visibleNavigation(false);
  assert.deepEqual(groups.map((group) => group.label), ["Workspace", "Business", "System"]);
  const routes = groups.flatMap((group) => group.items.map((item) => item.route));
  assert.deepEqual(routes, ["home", "ask", "queue", "work", "projects", "workflows", "memory", "artifacts", "sections", "finance", "profiles", "infra", "machines", "agents", "notifications"]);
  assert.equal(new Set(routes).size, routes.length);
  for (const route of Object.values(navigationKeys)) assert.ok(routes.includes(route));
  assert.deepEqual(visibleNavigation(true).flatMap((group) => group.items.map((item) => item.route)).filter((route) => !routes.includes(route)), ["orca"]);
});

test("desktop keeps Ask in its primary action and More omits bottom tab destinations", () => {
  for (const orca of [false, true]) {
    const all = visibleNavigation(orca).flatMap((group) => group.items.map((item) => item.route));
    const desktop = visibleNavigation(orca, "desktop").flatMap((group) => group.items.map((item) => item.route));
    const more = visibleNavigation(orca, "more").flatMap((group) => group.items.map((item) => item.route));
    assert.deepEqual(desktop, all.filter((route) => route !== "ask"));
    assert.deepEqual(more, all.filter((route) => !primaryNavigationRoutes.some((primary) => primary === route)));
    assert.deepEqual([...new Set([...primaryNavigationRoutes, ...more])].sort(), [...all].sort());
    for (const surface of ["desktop", "more"] as const) {
      assert.ok(visibleNavigation(orca, surface).every((group) => group.items.length > 0));
    }
  }
});
