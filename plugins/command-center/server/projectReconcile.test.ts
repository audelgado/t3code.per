import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { listMemory, saveMemory, setMemoryDone } from "./memory.ts";
import { createSectionService } from "./sections.ts";
import { createProjectReconciler, parseAuditReport, type AuditReport } from "./projectReconcile.ts";

const report = (): AuditReport => ({ version: 1, revision: "abc1234", progress: "Falta validar la entrega.", evidence: ["docs/PRD.md:12"],
  phases: [{ key: "validation", name: "Validación", status: "review", summary: "Comprobar criterios", evidence: ["docs/PRD.md:20-24"] }],
  todos: [{ key: "acceptance", text: "Validar el flujo de leads", phaseKey: "validation", evidence: ["docs/PRD.md:24"] }], questions: [] });
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("create table projects(machine_id text, project_id text); insert into projects values ('tayna', 'sensei')");
  const service = createProjectReconciler(db);
  return { db, service, apply: (id: string, data = report()) => service.apply({ id, machineId: "tayna", projectId: "sensei", report: data }) };
}

test("audit imports are durable and repeat runs keep stable keys without duplicate records", () => {
  const { db, service, apply } = fixture();
  try {
    const first = apply("one");
    assert.equal(first.addedPhases, 1); assert.equal(first.addedTodos, 1);
    assert.deepEqual(apply("one"), first);
    const second = createProjectReconciler(db).apply({ id: "two", machineId: "tayna", projectId: "sensei", report: report() });
    assert.equal(second.addedPhases, 0); assert.equal(second.addedTodos, 0);
    assert.equal(second.progressId, first.progressId);
    assert.equal(service.snapshot("sensei").todos.length, 1);
    assert.throws(() => apply("one", { ...report(), progress: "Un informe diferente" }), /different content/);
  } finally { db.close(); }
});

test("adopts normalized seeded records and preserves manual completion, status and edits", () => {
  const { db, service, apply } = fixture();
  try {
    const sections = createSectionService(db);
    const phase = sections.create({ projectId: "sensei", name: "  VALIDACIÓN ", status: "blocked", blocker: "Usuario" });
    const todo = saveMemory(db, { projectId: "sensei", kind: "todo", text: "VALIDAR  el flujo de leads" }, "user");
    setMemoryDone(db, todo.id, true);
    const first = apply("one");
    assert.equal(first.addedPhases, 0); assert.equal(first.addedTodos, 0);
    assert.equal(sections.get(phase.id)?.status, "blocked");
    assert.equal(listMemory(db, { projectId: "sensei", kind: "todo" }).entries[0]?.done, true);
    db.prepare("update cc_memory set text = ? where id = ?").run("Texto corregido por el usuario", todo.id);
    const next = apply("two");
    assert.match(next.questions.join(" "), /conservó/);
    assert.equal(service.snapshot("sensei").todos[0]?.text, "Texto corregido por el usuario");
    assert.equal(service.snapshot("sensei").todos[0]?.done, true);
  } finally { db.close(); }
});

test("changed stable keys raise conflicts instead of overwriting or duplicating", () => {
  const { db, service, apply } = fixture();
  try {
    apply("one");
    const next = report(); next.todos[0]!.text = "Otro alcance"; next.phases[0]!.name = "Otra fase";
    const result = apply("two", next);
    assert.equal(result.addedTodos, 0); assert.equal(result.addedPhases, 0); assert.equal(result.questions.length, 2);
    assert.equal(service.snapshot("sensei").todos[0]?.text, report().todos[0]!.text);
  } finally { db.close(); }
});

test("untrusted invalid report cannot partially import phases, todos or progress", () => {
  const { db, service, apply } = fixture();
  try {
    const invalid = report(); invalid.todos[0]!.evidence = ["../secret"];
    assert.throws(() => apply("one", invalid), /relative repository/);
    assert.equal(service.snapshot("sensei").phases.length, 0);
    assert.equal(service.snapshot("sensei").todos.length, 0);
    assert.equal(service.snapshot("sensei").progress.length, 0);
    assert.equal(db.prepare("select count(*) as n from cc_project_audit_imports").get()!.n, 0);
    assert.equal(apply("one").addedTodos, 1);
  } finally { db.close(); }
});

test("machine collisions reject snapshot and application instead of crossing project plans", () => {
  const { db, service, apply } = fixture();
  try {
    db.exec("insert into projects values ('pc', 'sensei')");
    assert.throws(() => apply("one"), /Ambiguous project/);
    assert.throws(() => service.snapshot("sensei"), /Ambiguous project/);
    assert.equal(db.prepare("select count(*) as n from cc_memory").get()!.n, 0);
  } finally { db.close(); }
});

test("parser requires evidence and bounds structure, keys, paths and text", () => {
  assert.deepEqual(parseAuditReport(report()), report());
  for (const ref of ["/etc/passwd", "C:/data/file.md", "docs/../../secret", "https://example.com", "docs\\PRD.md", "file.md\nmalicious"]) {
    assert.throws(() => parseAuditReport({ ...report(), evidence: [ref] }));
  }
  assert.equal(parseAuditReport({ ...report(), evidence: ["commit:abcdef123", ".t3/plan.md:4"] }).evidence.length, 2);
  for (const patch of [{ revision: "" }, { evidence: [] }, { questions: Array(11).fill("Question") }, { progress: "x".repeat(4001) },
    { phases: Array(21).fill(report().phases[0]) }, { todos: Array(61).fill(report().todos[0]) },
    { todos: [{ ...report().todos[0], phaseKey: "missing" }] }, { phases: [{ ...report().phases[0], status: "done", evidence: [] }] },
    { prdPath: "../PRD.md" }]) assert.throws(() => parseAuditReport({ ...report(), ...patch }));
});

test("transaction rolls back if a storage operation fails after a phase was created", () => {
  const { db, service, apply } = fixture();
  try {
    db.exec("create trigger reject_audit_todo before insert on cc_memory when new.kind = 'todo' begin select raise(abort, 'storage failure'); end");
    assert.throws(() => apply("one"), /storage failure/);
    assert.equal(service.snapshot("sensei").phases.length, 0);
    assert.equal(db.prepare("select count(*) as n from cc_project_audit_keys").get()!.n, 0);
    db.exec("drop trigger reject_audit_todo");
    assert.equal(apply("one").addedPhases, 1);
  } finally { db.close(); }
});
