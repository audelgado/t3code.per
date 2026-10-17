import assert from "node:assert/strict";
import { test } from "node:test";
import { projectAuditWorkflow } from "./projectAuditWorkflow.ts";
import { parseWorkflow } from "./workflows.ts";

const reportPath = ".t3/cc-audits/12345678-1234-1234-1234-123456789abc/proposal.json";

test("organizer workflow remains a valid sequential evidence review on the selected model", () => {
  const workflow = projectAuditWorkflow({ slug: "audit-project", reportPath, context: "machineId: tayna; projectId: sensei; root: /repo/sensei; rf-01 existente", answers: "Priorizar captura de leads." });
  assert.deepEqual(parseWorkflow(workflow).errors, []);
  assert.deepEqual(workflow.edges, [{ from: "research", to: "review" }]);
  assert.equal(workflow.nodes.length, 2);
  for (const node of workflow.nodes) {
    assert.equal(node.kind, "agent");
    assert.ok(node.kind === "agent");
    assert.equal(node.profile, undefined);
    assert.equal(node.worktree, undefined);
    assert.ok(node.prompt.includes(reportPath));
    assert.ok(node.prompt.includes(reportPath.replace("proposal.json", "research.json")));
    assert.ok(node.prompt.includes("machineId: tayna; projectId: sensei; root: /repo/sensei; rf-01 existente"));
    assert.ok(node.prompt.includes("Priorizar captura de leads."));
    assert.match(node.prompt, /20 phases, 60 todos y 10 questions/);
    assert.match(node.prompt, /revision 1–120; progress 1–4000; phase\.name 1–80; phase\.summary 1–500; todo\.text 1–2000/);
    assert.match(node.prompt, /cada question 1–500; cada key y phaseKey 1–100/);
    assert.match(node.prompt, /de 1 a 10 referencias, cada una de hasta 300 caracteres/);
    assert.match(node.prompt, /24576 bytes/);
    assert.match(node.prompt, /Buffer\.byteLength\(JSON\.stringify\(informe\), "utf8"\) <= 24576/);
    assert.match(node.prompt, /Nunca presentes el subconjunto como una revisión completa/);
    assert.match(node.prompt, /en progress el alcance omitido y en questions cómo continuar/);
    assert.match(node.prompt, /Todos son siempre pendientes/);
    assert.match(node.prompt, /No uses herramientas de escritura del Command Center ni solicites sus credenciales/);
    assert.match(node.prompt, /Excluí secretos, credenciales, archivos \.env/);
    assert.match(node.prompt, /Nunca cambies de máquina, proyecto ni raíz/);
    assert.match(node.prompt, /No investigues la web externa salvo/);
    assert.match(node.prompt, /no hagas commits, deploys ni ejecutes tests/);
    assert.match(node.prompt, /No pegues el JSON completo/);
  }
  const reviewer = workflow.nodes[1];
  assert.ok(reviewer?.kind === "agent");
  assert.match(reviewer.prompt, /releé las evidencias citadas/);
});

test("maximum service context and answers still fit the workflow prompt limit", () => {
  const workflow = projectAuditWorkflow({ slug: "audit", reportPath, context: "x".repeat(8500), answers: "a".repeat(4000) });
  assert.deepEqual(parseWorkflow(workflow).errors, []);
  for (const node of workflow.nodes) {
    assert.ok(node.kind === "agent");
    assert.ok(node.prompt.length <= 20_000, `prompt length ${node.prompt.length}`);
  }
});

test("organizer refuses reports outside its exact run-scoped folder", () => {
  for (const path of ["/tmp/proposal.json", "../proposal.json", ".t3/cc-audits/a/../../proposal.json", ".t3/cc-audits/latest/proposal.json", reportPath.replace("proposal.json", "other.json")]) {
    assert.throws(() => projectAuditWorkflow({ slug: "audit", reportPath: path, context: "", answers: "" }), /<uuid>/);
  }
});
