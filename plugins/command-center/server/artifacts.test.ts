import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ARTIFACT_MAX_BYTES,
  artifactRoutes,
  artifactTools,
  getArtifact,
  lineDiff,
  listArtifacts,
  openArtifacts,
  restoreArtifactVersion,
  saveArtifact,
  setArtifactArchived,
} from "./artifacts.ts";
import { openDb } from "./db.ts";

function fresh(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-art-"));
  const db = openDb(home);
  const store = openArtifacts(db, home);
  t.after(() => (db.close(), rmSync(home, { recursive: true, force: true })));
  return { store, home };
}

test("save creates, versions, renames and detects kind; list pages newest first", (t) => {
  const { store } = fresh(t);
  const html = saveArtifact(store, { title: "Mock", content: "<!doctype html><p>v1</p>" }, "user");
  assert.deepEqual([html.artifact.kind, html.artifact.currentVersion, html.version.author], ["html", 1, "user"]);
  const md = saveArtifact(store, { title: "Plan", content: "# Plan\n- a", projectId: "p1" }, "hermes");
  assert.equal(md.artifact.kind, "markdown");

  const v2 = saveArtifact(store, { id: html.artifact.id, title: "Mock 2", content: "<!doctype html><p>v2</p>" }, "hermes");
  assert.deepEqual([v2.artifact.currentVersion, v2.artifact.title, v2.content], [2, "Mock 2", "<!doctype html><p>v2</p>"]);
  assert.deepEqual(v2.versions.map((v) => [v.version, v.author]), [[2, "hermes"], [1, "user"]]);
  assert.equal(getArtifact(store, html.artifact.id, 1).content, "<!doctype html><p>v1</p>");
  assert.throws(() => saveArtifact(store, { id: html.artifact.id, kind: "markdown", content: "x" }, "user"), /kind cannot change/);
  assert.throws(() => saveArtifact(store, { content: "x" }, "user"), /needs a title/);
  assert.throws(() => saveArtifact(store, { title: "x", content: "  " }, "user"), /content/);

  // Versioning moved Mock to the top; project filter and title search narrow it.
  const ids = (i: Parameters<typeof listArtifacts>[1]) => listArtifacts(store.db, i).artifacts.map((a) => a.id);
  store.db.prepare("update cc_artifacts set updated_at = ? where id = ?").run("2026-01-01T00:00:00.000Z", md.artifact.id);
  assert.deepEqual(ids({}), [html.artifact.id, md.artifact.id]);
  assert.deepEqual(ids({ projectId: "p1" }), [md.artifact.id]);
  assert.deepEqual(ids({ projectId: null }), [html.artifact.id]);
  assert.deepEqual(ids({ query: "mock" }), [html.artifact.id]);
  assert.deepEqual(ids({ query: "%" }), []);
  const first = listArtifacts(store.db, { limit: 1 });
  assert.equal(first.hasMore, true);
  const last = first.artifacts[0]!;
  assert.deepEqual(ids({ limit: 1, before: last.id, beforeUpdatedAt: last.updatedAt }), [md.artifact.id]);

  // Archive hides it, a new version (or archived: false) brings it back.
  setArtifactArchived(store.db, md.artifact.id, true);
  assert.deepEqual(ids({}), [html.artifact.id]);
  assert.deepEqual(ids({ archived: true }), [md.artifact.id]);
  assert.equal(setArtifactArchived(store.db, md.artifact.id, false).archivedAt, null);

  // Restore appends the old content as a new version.
  const restored = restoreArtifactVersion(store, html.artifact.id, 1, "user");
  assert.deepEqual([restored.version.version, restored.content], [3, "<!doctype html><p>v1</p>"]);
});

test("ids and versions never reach a path; size is capped before anything is written", (t) => {
  const { store, home } = fresh(t);
  for (const id of ["../cc.sqlite", "..\\cc.sqlite", "/etc/passwd", "x"]) {
    assert.throws(() => getArtifact(store, id), /not found/);
    assert.throws(() => saveArtifact(store, { id, content: "x" }, "user"), /not found/);
  }
  const a = saveArtifact(store, { title: "T", content: "x" }, "user");
  assert.throws(() => getArtifact(store, a.artifact.id, 9), /version not found/);

  assert.throws(() => saveArtifact(store, { title: "Big", content: "é".repeat(ARTIFACT_MAX_BYTES / 2 + 1) }, "user"), /at most/);
  assert.equal(listArtifacts(store.db).artifacts.length, 1);
  assert.deepEqual(readdirSync(join(home, "artifacts")), [`${a.artifact.id}-v1.md`]);
  assert.ok(existsSync(join(home, "cc.sqlite")));
});

test("lineDiff marks added, removed and kept lines", () => {
  assert.deepEqual(lineDiff("a\nb\nc\nd", "a\nc\nx\nd"), [
    { op: " ", text: "a" },
    { op: "-", text: "b" },
    { op: " ", text: "c" },
    { op: "+", text: "x" },
    { op: " ", text: "d" },
  ]);
  assert.deepEqual(lineDiff("same", "same"), [{ op: " ", text: "same" }]);
});

test("MCP tools write as the agent; routes map errors to HTTP", async (t) => {
  const { store } = fresh(t);
  const tools = Object.fromEntries(artifactTools(store).map((d) => [d.name, d]));
  const saved = tools.artifact_save!.handler({ title: "Report", content: "# Hi" }, "hermes") as { id: string; version: number };
  assert.equal(saved.version, 1);
  const got = tools.artifact_get!.handler({ id: saved.id }, "hermes") as ReturnType<typeof getArtifact>;
  assert.deepEqual([got.content, got.version.author], ["# Hi", "hermes"]);
  assert.deepEqual((tools.artifact_list!.handler({ query: "rep" }, "x") as ReturnType<typeof listArtifacts>).artifacts.map((a) => a.id), [saved.id]);
  assert.throws(() => tools.artifact_get!.handler({ id: saved.id, version: 0 }, "x"), /positive integer/);

  const routes = Object.fromEntries(artifactRoutes(store).map((r) => [`${r.method} ${r.path}`, r]));
  const run = (key: string, ctx: { params?: Record<string, string>; body?: unknown; query?: string }) =>
    routes[key]!.handler({ params: ctx.params ?? {}, body: ctx.body, url: new URL(`http://cc/x${ctx.query ?? ""}`) } as never);
  saveArtifact(store, { id: saved.id, content: "# Hi\nmore" }, "user");
  const diff = run("GET /api/artifacts/:id/diff", { params: { id: saved.id } }) as { from: number; to: number; lines: unknown[] };
  assert.deepEqual([diff.from, diff.to, diff.lines.length], [1, 2, 2]);
  assert.throws(() => run("GET /api/artifacts/:id/diff", { params: { id: saved.id }, query: "?to=1" }), { status: 400 });
  assert.throws(() => run("GET /api/artifacts/:id", { params: { id: "../cc.sqlite" } }), { status: 404 });
  assert.throws(() => run("POST /api/artifacts/:id/restore", { params: { id: saved.id }, body: {} }), { status: 400 });
  assert.throws(() => run("POST /api/artifacts/:id/archive", { params: { id: saved.id }, body: {} }), { status: 400 });
});
