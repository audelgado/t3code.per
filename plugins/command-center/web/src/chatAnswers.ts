import type { UserInputAnswers, UserInputQuestion } from "../../server/types.ts";
import { validateThreadAnswers } from "../../server/threadAnswers.ts";

/** Identifica la primera respuesta inválida con la misma validación del servidor. */
export function chatAnswerIssue(questions: UserInputQuestion[], answers: UserInputAnswers) {
  for (const q of questions) {
    try { validateThreadAnswers([q], answers[q.id] === undefined ? {} : { [q.id]: answers[q.id] }); }
    catch {
      return { questionId: q.id, message: q.allowCustomAnswer === false ? `Elige una opción válida para «${q.header}».` : `Completa una respuesta válida para «${q.header}» (hasta 20000 caracteres).` };
    }
  }
  return null;
}
