import { useId, useRef, useState } from "react";
import type { UserInputAnswers, UserInputQuestion } from "../../server/types.ts";
import { validateThreadAnswers } from "../../server/threadAnswers.ts";
import { Button } from "./ui/Button.tsx";
import { DictationTextarea } from "./DictationTextarea.tsx";
import { chatAnswerIssue } from "./chatAnswers.ts";

/** Provider questions retain their IDs and exact option values, including multiple selections. */
export function ThreadInput({ questions, busy, onSubmit }: { questions: UserInputQuestion[]; busy: boolean; onSubmit: (answers: UserInputAnswers) => void }) {
  const [recording, setRecording] = useState<Record<string, boolean>>({});
  const listening = Object.values(recording).some(Boolean);
  const [draft, setDraft] = useState<UserInputAnswers>({});
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const fields = useRef(new Map<string, HTMLFieldSetElement>());
  const errorId = useId();
  const answers = Object.fromEntries(questions.flatMap((q) => { const value = draft[q.id] ?? q.initialAnswer; return value === undefined ? [] : [[q.id, value]]; }));
  const set = (id: string, value: string | string[]) => { setDraft((prev) => ({ ...prev, [id]: value })); if (invalid === id) { setInvalid(null); setError(null); } };
  return <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (listening || busy) return; const issue = chatAnswerIssue(questions, answers); if (issue) { setInvalid(issue.questionId); setError(issue.message); requestAnimationFrame(() => { const field = fields.current.get(issue.questionId); (field?.querySelector<HTMLElement>("input, textarea, select") ?? field)?.focus(); }); return; } try { const checked = validateThreadAnswers(questions, answers); setError(null); setInvalid(null); onSubmit(checked); } catch { setError("No se pudieron validar las respuestas. Actualiza el formulario e inténtalo de nuevo."); } }}>
    {questions.map((q) => {
      const value = answers[q.id];
      const invalidProps = { "aria-invalid": invalid === q.id || undefined, "aria-describedby": invalid === q.id ? errorId : undefined } as const;
      return <fieldset key={q.id} tabIndex={-1} ref={(el) => { if (el) fields.current.set(q.id, el); else fields.current.delete(q.id); }} {...invalidProps} className="grid min-w-0 gap-2 rounded-ctl border border-line p-3" disabled={busy}>
        <legend className="px-1 font-semibold">{q.header}{q.required === false ? " (opcional)" : ""}</legend>
        <p className="break-words text-sm">{q.question}</p>
        {q.options.map((o, i) => { const option = o.value ?? o.label; const checked = Array.isArray(value) ? value.includes(option) : value === option;
          return <label key={i} className="flex cursor-pointer items-start gap-2 rounded-ctl border border-line p-2 text-sm"><input {...invalidProps} className="mt-1 size-4 shrink-0 accent-primary" type={q.multiSelect ? "checkbox" : "radio"} name={q.id} checked={checked} onChange={() => set(q.id, q.multiSelect ? checked ? (Array.isArray(value) ? value : []).filter((v) => v !== option) : [...(Array.isArray(value) ? value : []), option] : option)} /><span className="grid min-w-0 gap-0.5"><strong className="break-words">{o.label}</strong>{o.description && <span className="break-words text-muted-fg">{o.description}</span>}</span></label>;
        })}
        {q.allowCustomAnswer !== false && <DictationTextarea {...invalidProps} disabled={busy} aria-label={`Respuesta: ${q.header}`} placeholder={q.options.length ? "O escribe tu respuesta" : "Escribe tu respuesta"} maxLength={20000} value={typeof value === "string" && (!q.options.some((o) => (o.value ?? o.label) === value) || q.initialAnswer !== undefined) ? value : ""} onValueChange={(value) => set(q.id, value)} onListeningChange={(active) => setRecording((prev) => prev[q.id] === active ? prev : { ...prev, [q.id]: active })} />}
      </fieldset>;
    })}
    {error && <p id={errorId} role="alert" className="text-fail">{error}</p>}
    <Button type="submit" variant="primary" disabled={busy || listening}>Enviar respuestas</Button>
  </form>;
}
