import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openArtifacts, listArtifacts } from "./artifacts.ts";
import { openDb, replaceProjects, upsertMachine } from "./db.ts";
import { listMemory, saveMemory } from "./memory.ts";
import { createProjectAudits, type ProjectAuditDeps } from "./projectAudit.ts";
import type { LinkState, T3Link } from "./types.ts";
import type { RunDetail, RunInput, Workflow } from "./workflows.ts";

const timestamp = "2026-10-16T12:00:00.000Z";
const report = () => ({ version: 1, revision: "abcdef1234567", progress: "PRD definido; falta validar captura.", evidence: ["docs/PRD.md"],
  phases: [{ key: "captura", name: "Captura", status: "todo", summary: "Formulario de leads", evidence: ["docs/PRD.md"] }],
  todos: [{ key: "rf-01", text: "Validar captura de leads con un envío real", phaseKey: "captura", evidence: ["docs/PRD.md"] }], questions: [] as string[] });

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-audit-test-"));
  const db = openDb(home);
  t.after(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  const artifacts = openArtifacts(db, home);
  for (const id of ["pc", "tayna"]) {
    upsertMachine(db, { id, label: id, apiUrl: `https://${id}`, webUrl: null, maxConcurrent: 2, enabled: true, serverVersion: null, tokenExpiresAt: null, createdAt: timestamp });
    replaceProjects(db, id, [{ machineId: id, id: `${id}-project`, title: id, workspaceRoot: `/repo/${id}`, defaultModel: null, updatedAt: timestamp }]);
  }
  let definition: Workflow | undefined;
  const launches: RunInput[] = [];
  const runs = new Map<string, RunDetail>();
  const workflows: ProjectAuditDeps["workflows"] = {
    save(value, by) {
      definition = value as Workflow;
      return { slug: definition.slug, title: definition.title, description: definition.description, inputs: definition.inputs, nodeCount: definition.nodes.length, updatedBy: by, updatedAt: timestamp };
    },
    start(input, source) {
      assert.ok(definition);
      launches.push(input);
      const detail: RunDetail = { run: { id: `run-${launches.length}`, slug: definition.slug, title: definition.title, workflow: definition,
        inputs: {}, machineId: input.machineId, projectId: input.projectId, model: input.model ?? null, runtimeMode: input.runtimeMode ?? null,
        source, status: "running", error: null, worktreePath: null, createdAt: timestamp, updatedAt: timestamp, finishedAt: null }, steps: [] };
      runs.set(detail.run.id, detail);
      return detail;
    },
    detail(id) { const value = runs.get(id); assert.ok(value); return value; },
  };
  const file = { contents: JSON.stringify(report()), truncated: false };
  const reads: { machineId: string; cwd: string; path: string }[] = [];
  const requested: string[] = [];
  const state = (): LinkState => ({ status: "online", since: timestamp, degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: "1", message: null });
  const makeLink = (machineId: string) => ({
    machineId, state: state(),
    async launch() { throw new Error("audit must use workflow dispatch"); }, async interrupt() {}, async respond() {}, async settle() {}, close() {},
    async providers() { return [{ instanceId: `${machineId}-codex`, driver: "codex", displayName: "Codex", enabled: true, installed: true, models: [{ slug: "model", name: "Model", isDefault: true }] }]; },
    async readResult() { return { text: null, pending: null }; }, async session() { return { expiresAt: null, scopes: [] }; },
    async readFile(cwd: string, path: string) { reads.push({ machineId, cwd, path }); return path.endsWith("proposal.json") ? { ...file } : { contents: "# PRD\nCapturar leads", truncated: false }; },
  } satisfies T3Link & Pick<NonNullable<ReturnType<ProjectAuditDeps["link"]>>, "readFile">);
  const links = { pc: makeLink("pc"), tayna: makeLink("tayna") };
  const audits = createProjectAudits({ db, artifacts, workflows, link(id) { requested.push(id); return id === "pc" ? links.pc : id === "tayna" ? links.tayna : undefined; } });
  const complete = (runId: string) => {
    const detail = workflows.detail(runId);
    detail.run.status = "succeeded";
    detail.steps = detail.run.workflow.nodes.map((node) => ({ id: node.id, runId, nodeId: node.id, item: null, status: "succeeded", taskId: `task-${node.id}`, output: "Informe escrito; ver archivo.", error: null, createdAt: timestamp, updatedAt: timestamp, taskStatus: "done", threadId: `thread-${node.id}` }));
  };
  return { db, artifacts, audits, links, launches, requested, file, reads, complete };
}

test("offline requested VPS never falls back to the online PC", async (t) => {
  const f = setup(t);
  f.links.tayna.state.status = "offline";
  await assert.rejects(f.audits.start({ machineId: "tayna", projectId: "tayna-project" }), /línea/);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.requested, ["tayna"]);
  assert.equal(f.audits.list("tayna", "tayna-project").length, 0);
});

test("start binds exact machine/project/model and reuses an active audit", async (t) => {
  const f = setup(t);
  const input = { machineId: "tayna", projectId: "tayna-project", model: { instanceId: "tayna-codex", model: "model" }, answers: "Captura primero" };
  const first = await f.audits.start(input);
  assert.equal((await f.audits.start(input)).id, first.id);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0], { slug: "ordenar-proyecto", machineId: "tayna", projectId: "tayna-project", model: input.model, runtimeMode: "full-access" });
  assert.match(first.reportPath, /^\.t3\/cc-audits\/[0-9a-f-]+\/proposal\.json$/);
  assert.deepEqual(f.reads, []);
});

test("finished research/review reads the report on its VPS and applies persisted plan once", async (t) => {
  const f = setup(t);
  const audit = await f.audits.start({ machineId: "tayna", projectId: "tayna-project" });
  await f.audits.advance();
  assert.deepEqual(f.reads, [], "running tasks cannot import a partial file");
  f.file.contents = JSON.stringify({ ...report(), prdPath: "docs/PRD.md" });
  f.complete(audit.workflowRunId);
  await f.audits.advance();
  const applied = f.audits.list("tayna", "tayna-project")[0]!;
  assert.equal(applied.status, "applied");
  assert.ok(applied.artifactId);
  assert.equal(listMemory(f.db, { projectId: "tayna-project", kind: "todo" }).entries.length, 1);
  assert.equal(listMemory(f.db, { projectId: "tayna-project", kind: "todo" }).entries[0]?.done, false);
  assert.equal(listMemory(f.db, { projectId: "tayna-project", kind: "progress" }).entries.length, 1);
  assert.equal(listMemory(f.db, { projectId: "pc-project" }).entries.length, 0);
  assert.deepEqual(f.reads, [{ machineId: "tayna", cwd: "/repo/tayna", path: audit.reportPath }, { machineId: "tayna", cwd: "/repo/tayna", path: "docs/PRD.md" }]);
  const artifacts = listArtifacts(f.db, { projectId: "tayna-project" }).artifacts;
  assert.equal(artifacts.length, 2, "keeps the report and missing PRD");
  await f.audits.advance();
  assert.equal(f.reads.length, 2);
  assert.equal(listMemory(f.db, { projectId: "tayna-project" }).entries.length, 2);
  assert.equal(listArtifacts(f.db, { projectId: "tayna-project" }).artifacts.length, artifacts.length);
});

test("invalid or truncated report preserves existing memory and applies no partial plan", async (t) => {
  for (const invalid of ["malformed", "schema", "truncated"] as const) {
    const f = setup(t);
    saveMemory(f.db, { projectId: "tayna-project", kind: "todo", text: "Pendiente manual" }, "user");
    const before = listMemory(f.db, { projectId: "tayna-project" });
    const audit = await f.audits.start({ machineId: "tayna", projectId: "tayna-project" });
    f.complete(audit.workflowRunId);
    if (invalid === "malformed") f.file.contents = "{";
    if (invalid === "schema") f.file.contents = JSON.stringify({ ...report(), todos: [{ ...report().todos[0], evidence: [] }] });
    if (invalid === "truncated") f.file.truncated = true;
    await f.audits.advance();
    assert.equal(f.audits.list("tayna", "tayna-project")[0]?.status, "failed", invalid);
    assert.deepEqual(listMemory(f.db, { projectId: "tayna-project" }), before, invalid);
    assert.equal(listArtifacts(f.db, { projectId: "tayna-project" }).artifacts.length, 0, invalid);
  }
});

test("evidence-backed report with unresolved questions is visible as needs_you", async (t) => {
  const f = setup(t);
  const audit = await f.audits.start({ machineId: "tayna", projectId: "tayna-project" });
  f.file.contents = JSON.stringify({ ...report(), questions: ["¿La captura requiere consentimiento explícito?"] });
  f.complete(audit.workflowRunId);
  await f.audits.advance();
  const result = f.audits.list("tayna", "tayna-project")[0]!;
  assert.equal(result.status, "needs_you");
  assert.deepEqual(result.questions, ["¿La captura requiere consentimiento explícito?"]);
  assert.ok(result.artifactId);
  await f.audits.advance();
  assert.equal(listMemory(f.db, { projectId: "tayna-project", kind: "todo" }).entries.length, 1);
});
