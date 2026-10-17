import assert from "node:assert/strict";
import test from "node:test";
import { destinations, destOf, hashes, navigationKeys, pages, parseRoute, phoneTab, resolveShortcut, subPages, type Page } from "./navigation.ts";

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

test("Ctrl/Cmd+K opens Pedir, also while typing, but never over a dialog or with other modifiers", () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.deepEqual(resolveShortcut({ key: "k", ...mod }, null, 100).action, { type: "ask" });
    assert.deepEqual(resolveShortcut({ key: "K", editable: true, ...mod }, null, 100).action, { type: "ask" });
    for (const blocked of [{ dialogOpen: true }, { repeat: true }, { isComposing: true }, { altKey: true }, { shiftKey: true }]) {
      assert.equal(resolveShortcut({ key: "k", ...mod, ...blocked }, null, 100).action, undefined);
    }
  }
  assert.equal(resolveShortcut({ key: "k" }, null, 100).action, undefined);
});

test("five destinations own every page except Más, and sub-tabs exist only where the design has them", () => {
  assert.deepEqual(destinations.map((d) => d.label), ["Hoy", "Trabajo", "Proyectos", "Dinero", "Flota"]);
  const owned = destinations.flatMap((d) => d.pages);
  assert.equal(new Set(owned).size, owned.length);
  assert.deepEqual([...owned, "project", "more"].sort(), Object.keys(pages).sort());
  for (const d of destinations) for (const page of d.pages) assert.equal(destOf(page), d.id);
  assert.deepEqual(subPages("board").map((p) => pages[p].label), ["Lista", "Tablero", "Flujos"]);
  assert.deepEqual(subPages("memory").map((p) => pages[p].label), ["Todos", "Artefactos", "Memoria"]);
  assert.deepEqual(subPages("agents").map((p) => pages[p].label), ["Máquinas", "Agentes", "Notificaciones"]);
  for (const page of ["home", "money", "project", "more"] as const) assert.deepEqual(subPages(page), []);
});

test("every shortcut target resolves to a page or to the Pedir overlay", () => {
  for (const route of Object.values(navigationKeys)) {
    const parsed = parseRoute("#" + route);
    assert.ok(route === "ask" ? parsed.overlay?.type === "ask" : pages[parsed.page].hash === route, route);
  }
});

test("phone tabs: Hoy, Trabajo and Proyectos own their pages; the rest lives under Más", () => {
  const tab = (p: Page) => phoneTab(p);
  assert.deepEqual(["home", "work", "board", "flows", "projects", "project", "artifacts", "memory"].map((p) => tab(p as Page)),
    ["home", "work", "work", "work", "projects", "projects", "projects", "projects"]);
  assert.deepEqual(["money", "fleet", "agents", "notifications", "more"].map((p) => tab(p as Page)), ["more", "more", "more", "more", "more"]);
});

test("hashes round-trip through parseRoute", () => {
  for (const page of Object.keys(pages) as Page[]) if (page !== "project") assert.equal(parseRoute(hashes.page(page)).page, page);
  const key = "m1:p/with space:1";
  assert.deepEqual(parseRoute(hashes.project(key, "sections")), { page: "project", taskId: null, runId: null, projectKey: key, tab: "sections", overlay: null });
  assert.equal(parseRoute(hashes.project(key)).tab, "chat");
  assert.equal(parseRoute(hashes.project(key, "bogus" as never)).tab, "chat");
  assert.equal(parseRoute(hashes.project(key, "overview")).tab, "overview");
  assert.equal(parseRoute(hashes.task("t 1")).taskId, "t 1");
  assert.equal(parseRoute(hashes.run("r1")).runId, "r1");
  assert.deepEqual(parseRoute(hashes.thread("env:thread 1")).overlay, { type: "thread", key: "env:thread 1" });
  assert.deepEqual(parseRoute(hashes.ask("m:p")).overlay, { type: "ask", project: "m:p", dictate: false });
  assert.deepEqual(parseRoute("#ask?dictate=1").overlay, { type: "ask", project: null, dictate: true });
});

test("push links and older hashes land on the new pages", () => {
  assert.deepEqual([parseRoute("#item=task:t1").page, parseRoute("#item=task:t1").taskId], ["work", "t1"]);
  assert.deepEqual([parseRoute("#item=workflow:r9:n1").page, parseRoute("#item=workflow:r9:n1").runId], ["flows", "r9"]);
  assert.deepEqual([parseRoute("#item=alert:offline:m1").page, parseRoute("#item=alert:offline:m1").overlay], ["home", null]);
  assert.equal(parseRoute("#workflows?run=r2").page, "flows");
  assert.equal(parseRoute("#workflows?run=r2").runId, "r2");
  for (const [old, page] of [["queue", "work"], ["finance", "money"], ["machines", "fleet"], ["infra", "fleet"], ["profiles", "agents"], ["memory", "memory"], ["artifacts", "artifacts"], ["sections", "projects"], ["", "home"], ["nope", "home"]] as const) {
    assert.equal(parseRoute("#" + old).page, page, old);
  }
});
