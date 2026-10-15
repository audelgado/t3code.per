import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb, replaceProjects } from "./db.ts";
import { HttpError } from "./http.ts";
import { resolveProject, ToolError } from "./mcp.ts";
import { createSections, selectSectionPage, type Section } from "./sections.ts";

// ---- ported from sectionDirectory.test.ts ----

const sections = Array.from({ length: 103 }, (_, index): Section => ({
  id: `section-${index}`,
  projectId: "p",
  name: `Section ${index}`,
  status: index % 2 === 0 ? "blocked" : "todo",
  tasksDone: 0,
  tasksTotal: 1,
  dueDate: null,
  trying: null,
  blocker: index === 40 ? "API unavailable" : null,
  missing: [],
  dependsOn: [],
  prUrl: null,
  sortKey: index,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
}));
const select = (patch: Partial<Parameters<typeof selectSectionPage>[0]> = {}) =>
  selectSectionPage({ sections, search: "", status: "all", page: 1, editing: null, ...patch });

test("pages a large project without dropping sections", () => {
  const pages = Array.from({ length: 11 }, (_, index) => select({ page: index + 1 }));
  assert.deepEqual(pages.flatMap((page) => page.visible), sections);
  assert.ok(pages.every((page) => page.visible.length <= 10));
});

test("searches blockers and combines status filters", () => {
  assert.deepEqual(select({ search: " API ", status: "blocked" }).visible, [sections[40]]);
  assert.equal(select({ search: "API", status: "todo" }).total, 0);
});

test("keeps the edited section on its page as live ordering changes", () => {
  const edited = sections[40]!;
  const result = select({ page: 1, editing: edited.id });
  assert.equal(result.page, 5);
  assert.ok(result.visible.includes(edited));
});

test("pins an active form when its section no longer matches filters", () => {
  const edited = sections[41]!;
  const result = select({ search: "API", editing: edited.id });
  assert.deepEqual(result.visible, [edited, sections[40]]);
  assert.equal(result.total, 1);
});

test("clamps the page after live deletions and releases a deleted edit", () => {
  const result = select({ sections: sections.slice(0, 3), page: 11, editing: sections[40]!.id });
  assert.equal(result.page, 1);
  assert.deepEqual(result.visible, sections.slice(0, 3));
});

// ---- service, routes, tools ----

function setup() {
  const db = openDb(mkdtempSync(join(tmpdir(), "cc-sections-")));
  replaceProjects(db, "m1", [
    { machineId: "m1", id: "p-app", title: "App", workspaceRoot: "/srv/app", defaultModel: null, updatedAt: "2026-10-15T00:00:00.000Z" },
    { machineId: "m1", id: "p-api", title: "Api", workspaceRoot: "/srv/api", defaultModel: null, updatedAt: "2026-10-15T00:00:00.000Z" },
  ]);
  const s = createSections(db, { HttpError, ToolError, resolveProject });
  const route = (method: string, path: string) => s.routes.find((r) => r.method === method && r.path === path)!;
  const tool = (name: string) => s.tools.find((t) => t.name === name)!;
  return { db, s, route, tool };
}

test("create is idempotent per project and name (any case), and orders sections", () => {
  const { s } = setup();
  const a = s.service.create({ projectId: "p-app", name: "Checkout" });
  const b = s.service.create({ projectId: "p-app", name: "Auth", status: "review", missing: ["tests"] });
  assert.equal(s.service.create({ projectId: "p-app", name: "CHECKOUT" }).id, a.id);
  assert.notEqual(s.service.create({ projectId: "p-api", name: "Checkout" }).id, a.id);
  assert.deepEqual(s.service.list("p-app").map((x) => x.name), ["Checkout", "Auth"]);
  assert.deepEqual([a.status, a.sortKey, b.status, b.sortKey, b.missing], ["todo", 0, "review", 1, ["tests"]]);
});

test("update keeps omitted fields, null clears, and rejects bad input", () => {
  const { s } = setup();
  const dep = s.service.create({ projectId: "p-api", name: "Schema" });
  const sec = s.service.create({ projectId: "p-app", name: "Checkout", trying: "stripe", blocker: "keys", dueDate: "2026-11-01" });
  const next = s.service.update(sec.id, { status: "blocked", blocker: null, tasksTotal: 4, dependsOn: [dep.id, dep.id], prUrl: "https://github.com/o/r/pull/1" });
  assert.deepEqual([next.status, next.blocker, next.trying, next.dueDate, next.tasksTotal, next.dependsOn, next.prUrl], ["blocked", null, "stripe", "2026-11-01", 4, [dep.id], "https://github.com/o/r/pull/1"]);
  assert.equal(s.service.update(sec.id, { prUrl: null, dueDate: null }).dueDate, null);
  for (const bad of [{ status: "nope" }, { tasksDone: -1 }, { dueDate: "tomorrow" }, { prUrl: "javascript:alert(1)" }, { dependsOn: [sec.id] }, { dependsOn: ["ghost"] }, { name: " " }, { missing: "x" }])
    assert.throws(() => s.service.update(sec.id, bad), /must|cannot|Unknown/, JSON.stringify(bad));
  assert.throws(() => s.service.update("ghost", {}), /not found/);
  s.service.create({ projectId: "p-app", name: "Auth" });
  assert.throws(() => s.service.update(sec.id, { name: "auth" }), /that name/);
});

test("routes map errors to HTTP statuses and need a known project", () => {
  const { route } = setup();
  const ctx = (extra: object) => ({ params: {}, url: new URL("http://cc/api/sections"), ...extra }) as never;
  const created = route("POST", "/api/sections").handler(ctx({ body: { projectId: "p-app", name: "Auth" } })) as { id: string };
  const status = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e instanceof HttpError ? e.status : -1;
    }
    return 200;
  };
  assert.equal(status(() => route("POST", "/api/sections").handler(ctx({ body: { projectId: "ghost", name: "X" } }))), 400);
  assert.equal(status(() => route("PATCH", "/api/sections/:id").handler(ctx({ params: { id: created.id }, body: { status: "x" } }))), 400);
  assert.equal(status(() => route("PATCH", "/api/sections/:id").handler(ctx({ params: { id: "ghost" }, body: {} }))), 404);
  assert.equal((route("GET", "/api/sections").handler(ctx({ url: new URL("http://cc/api/sections?project=p-api") })) as unknown[]).length, 0);
});

test("delete removes the section, drops it from dependsOn, and is not an MCP tool", () => {
  const { s, route } = setup();
  const dep = s.service.create({ projectId: "p-app", name: "Schema" });
  const other = s.service.create({ projectId: "p-api", name: "Auth", dependsOn: [dep.id] });
  const keep = s.service.create({ projectId: "p-api", name: "Keep" });
  const del = route("DELETE", "/api/sections/:id");
  assert.equal(del.auth, "cookie");
  const ctx = (id: string) => ({ params: { id }, url: new URL("http://cc/api/sections") }) as never;
  assert.deepEqual(del.handler(ctx(dep.id)), { ok: true });
  assert.equal(s.service.get(dep.id), undefined);
  assert.deepEqual(s.service.get(other.id)!.dependsOn, []);
  assert.equal(s.service.get(keep.id)!.name, "Keep");
  assert.throws(() => del.handler(ctx(dep.id)), (e) => e instanceof HttpError && e.status === 404);
  assert.ok(!s.tools.some((t) => /delete|remove/.test(t.name)));
});

test("MCP tools resolve projects by title or path and report errors to the agent", () => {
  const { tool } = setup();
  const made = tool("section_create").handler({ project: "app", name: "Checkout", tasksTotal: 2 }, "bot") as { id: string; projectId: string };
  assert.equal(made.projectId, "p-app");
  assert.equal((tool("section_create").handler({ project: "/srv/app/src", name: "checkout" }, "bot") as { id: string }).id, made.id);
  assert.equal((tool("section_update").handler({ id: made.id, status: "done", blocker: null }, "bot") as { status: string }).status, "done");
  assert.equal((tool("section_list").handler({ project: "Api" }, "bot") as unknown[]).length, 0);
  assert.equal((tool("section_list").handler({}, "bot") as unknown[]).length, 1);
  // Fork-shaped input: projectId filters too.
  assert.equal((tool("section_list").handler({ projectId: "p-api" }, "bot") as unknown[]).length, 0);
  assert.equal((tool("section_create").handler({ projectId: "p-api", name: "Auth" }, "bot") as { projectId: string }).projectId, "p-api");
  assert.throws(() => tool("section_create").handler({ project: "nope", name: "X" }, "bot"), ToolError);
  assert.throws(() => tool("section_update").handler({ id: made.id, status: "x" }, "bot"), ToolError);
  assert.throws(() => tool("section_update").handler({ id: "ghost" }, "bot"), ToolError);
});
