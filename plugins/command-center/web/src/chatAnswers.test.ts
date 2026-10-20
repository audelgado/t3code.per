import assert from "node:assert/strict";
import test from "node:test";
import type { UserInputQuestion } from "../../server/types.ts";
import { chatAnswerIssue, chatAnswerScope, restoreChatAnswers, submitChatAnswers } from "./chatAnswers.ts";

import { createChatDraftStore } from "./chatDrafts.ts";

const questions: UserInputQuestion[] = [
  { id: "optional", header: "Notas", question: "Notas", options: [], required: false },
  { id: "choice", header: "Destino", question: "Elige", options: [{ label: "Producción", description: "", value: "prod" }], allowCustomAnswer: false },
  { id: "text", header: "Instrucciones", question: "Instrucciones", options: [] },
];

test("identifica el primer campo inválido sin exigir los opcionales", () => {
  assert.equal(chatAnswerIssue(questions, {})?.questionId, "choice");
  assert.equal(chatAnswerIssue(questions, { choice: "valor obsoleto" })?.questionId, "choice");
  assert.equal(chatAnswerIssue(questions, { choice: "prod", text: "  " })?.questionId, "text");
  assert.equal(chatAnswerIssue(questions, { choice: "prod", text: "Continuar" }), null);
});

test("respeta selección múltiple, valores del proveedor y texto inicial editable", () => {
  const multi: UserInputQuestion = { id: "multi", header: "Ramas", question: "Ramas", options: [{ label: "Principal", description: "", value: "main" }], multiSelect: true, allowCustomAnswer: false };
  assert.equal(chatAnswerIssue([multi], { multi: ["Principal"] })?.questionId, "multi");
  assert.equal(chatAnswerIssue([multi], { multi: ["main"] }), null);
  assert.equal(chatAnswerIssue([{ ...questions[2]!, initialAnswer: "" }], { text: "" }), null);
});

test("restaura respuestas por entidad y solicitud; solo limpia al confirmar el servidor", async () => {
  const rows = new Map<string, string>();
  const session = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
  const drafts = createChatDraftStore(() => session);
  const scope = chatAnswerScope(JSON.stringify(["machine", "thread", "request"]), questions);
  const other = chatAnswerScope(JSON.stringify(["machine", "thread", "request-2"]), questions);
  const anotherThread = chatAnswerScope(JSON.stringify(["machine", "thread-2", "request"]), questions);
  const answers = { choice: "prod", text: "Continuar" };
  const sent = drafts.write(scope, JSON.stringify(answers));
  const clear = () => drafts.clearSent(scope, sent);
  assert.deepEqual(restoreChatAnswers(createChatDraftStore(() => session).read(scope)), answers);
  assert.deepEqual(restoreChatAnswers(drafts.read(other)), {});
  assert.deepEqual(restoreChatAnswers(drafts.read(anotherThread)), {});
  assert.notEqual(chatAnswerScope(JSON.stringify(["machine", "thread", "request"]), [questions[0]!]), scope);
  assert.equal(await submitChatAnswers(questions, answers, async () => false, clear), false);
  await assert.rejects(submitChatAnswers(questions, answers, async () => { throw new Error("Sin conexion"); }, clear));
  assert.deepEqual(restoreChatAnswers(createChatDraftStore(() => session).read(scope)), answers);
  drafts.write(other, JSON.stringify({ choice: "prod", text: "Otra solicitud" }));
  await submitChatAnswers(questions, answers, async (checked) => { assert.deepEqual(checked, answers); return true; }, clear);
  assert.deepEqual(restoreChatAnswers(createChatDraftStore(() => session).read(scope)), {});
  assert.equal(restoreChatAnswers(drafts.read(other)).text, "Otra solicitud");
});

test("un resultado tardio no borra respuestas editadas mientras se enviaban", async () => {
  const drafts = createChatDraftStore(() => undefined);
  const answers = { choice: "prod", text: "Continuar" };
  const sent = drafts.write("request", JSON.stringify(answers));
  let accept!: (success: boolean) => void;
  const response = new Promise<boolean>((resolve) => { accept = resolve; });
  const pending = submitChatAnswers(questions, answers, () => response, () => drafts.clearSent("request", sent));
  drafts.write("request", JSON.stringify({ ...answers, text: "Nueva respuesta" }));
  accept(true);
  await pending;
  assert.equal(restoreChatAnswers(drafts.read("request")).text, "Nueva respuesta");
});

test("rechaza respuestas invalidas antes del envio y tolera almacenamiento danado", async () => {
  let submitted = false;
  let cleared = false;
  await assert.rejects(submitChatAnswers(questions, {}, async () => { submitted = true; return true; }, () => { cleared = true; }));
  assert.equal(submitted, false);
  assert.equal(cleared, false);
  for (const text of ["", "incompleto", "null", "[]"]) assert.deepEqual(restoreChatAnswers(text), {});
  assert.deepEqual(restoreChatAnswers('{"text":"Respuesta","multi":["a","b"],"bad":false,"nested":{}}'), { text: "Respuesta", multi: ["a", "b"] });
});
