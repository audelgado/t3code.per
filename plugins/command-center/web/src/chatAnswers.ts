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

/** Descarta datos ajenos a respuestas sin recuperar errores de una solicitud anterior. */
export function restoreChatAnswers(text: string): UserInputAnswers {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).filter(([, answer]) => typeof answer === "string" || Array.isArray(answer) && answer.every((entry) => typeof entry === "string")));
    }
  } catch { /* Un formulario nuevo empieza sin respuestas. */ }
  return {};
}

export const chatAnswerScope = (entityRequest: string, questions: UserInputQuestion[]) => `answers:${entityRequest}:${JSON.stringify(questions)}`;

/** Una respuesta fallida conserva el borrador para el siguiente intento. */
export async function submitChatAnswers(questions: UserInputQuestion[], answers: UserInputAnswers, submit: (answers: UserInputAnswers) => Promise<boolean>, clearSent: () => void) {
  const success = await submit(validateThreadAnswers(questions, answers));
  if (success) clearSent();
  return success;
}
