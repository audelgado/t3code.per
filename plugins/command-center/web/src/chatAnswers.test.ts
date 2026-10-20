import assert from "node:assert/strict";
import test from "node:test";
import type { UserInputQuestion } from "../../server/types.ts";
import { chatAnswerIssue } from "./chatAnswers.ts";

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
