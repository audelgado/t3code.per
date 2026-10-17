import type { UserInputAnswers, UserInputQuestion } from "./types.ts";

/** Preserve provider option values and editable initial text; reject partial or obsolete forms. */
export function validateThreadAnswers(questions: UserInputQuestion[], raw: unknown): UserInputAnswers {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Completá las respuestas");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some((id) => !questions.some((q) => q.id === id))) throw new Error("Las preguntas cambiaron; actualizá el formulario");
  const answers: UserInputAnswers = {};
  for (const q of questions) {
    const value = input[q.id];
    if ((value === undefined || value === "" || (Array.isArray(value) && !value.length)) && q.required === false) continue;
    const options = q.options.map((o) => o.value ?? o.label);
    if (Array.isArray(value)) {
      if (!q.multiSelect || value.length > 50 || !value.length || value.some((v) => typeof v !== "string" || !options.includes(v))) throw new Error(`Elegí opciones válidas para ${q.header}`);
      answers[q.id] = [...new Set(value)] as string[];
    } else if (typeof value === "string" && value.length <= 20000) {
      if (!value.trim() && q.required !== false && q.initialAnswer === undefined) throw new Error(`Respondé ${q.header}`);
      if (q.allowCustomAnswer === false && !options.includes(value)) throw new Error(`Elegí una opción para ${q.header}`);
      answers[q.id] = value;
    } else throw new Error(`Respondé ${q.header}`);
  }
  return answers;
}
