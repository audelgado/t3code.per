import { useState } from "react";
import type { UserInputAnswers, UserInputQuestion } from "../../server/types.ts";
import { validateThreadAnswers } from "../../server/threadAnswers.ts";
import { Button } from "./ui/Button.tsx";
import { DictationTextarea } from "./DictationTextarea.tsx";

/** Provider questions retain their IDs and exact option values, including multiple selections. */
export function ThreadInput({ questions, busy, onSubmit }: { questions: UserInputQuestion[]; busy: boolean; onSubmit: (answers: UserInputAnswers) => void }) {
  const [recording, setRecording] = useState<Record<string, boolean>>({});
  const listening = Object.values(recording).some(Boolean);
  const [draft, setDraft] = useState<UserInputAnswers>({});
  const [error, setError] = useState<string | null>(null);
  const answers = Object.fromEntries(questions.flatMap((q) => draft[q.id] !== undefined ? [[q.id, draft[q.id]]] : q.initialAnswer !== undefined ? [[q.id, q.initialAnswer]] : []));
  const set = (id: string, value: string | string[]) => setDraft((prev) => ({ ...prev, [id]: value }));
  return <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (listening || busy) return; try { const checked = validateThreadAnswers(questions, answers); setError(null); onSubmit(checked); } catch (e) { setError(e instanceof Error ? e.message : "Completá las respuestas"); } }}>
    {questions.map((q) => {
      const value = answers[q.id];
      return <fieldset key={q.id} className="grid min-w-0 gap-2 rounded-ctl border border-line p-3" disabled={busy}>
        <legend className="px-1 font-semibold">{q.header}{q.required === false ? " (opcional)" : ""}</legend>
        <p className="break-words text-sm">{q.question}</p>
        {q.options.map((o, i) => { const option = o.value ?? o.label; const checked = Array.isArray(value) ? value.includes(option) : value === option;
          return <label key={i} className="flex cursor-pointer items-start gap-2 rounded-ctl border border-line p-2 text-sm"><input className="mt-1 size-4 shrink-0 accent-primary" type={q.multiSelect ? "checkbox" : "radio"} name={q.id} checked={checked} onChange={() => set(q.id, q.multiSelect ? checked ? (Array.isArray(value) ? value : []).filter((v) => v !== option) : [...(Array.isArray(value) ? value : []), option] : option)} /><span className="grid min-w-0 gap-0.5"><strong className="break-words">{o.label}</strong>{o.description && <span className="break-words text-muted-fg">{o.description}</span>}</span></label>;
        })}
        {q.allowCustomAnswer !== false && <DictationTextarea disabled={busy} aria-label={`Respuesta: ${q.header}`} placeholder={q.options.length ? "O escribí tu respuesta" : "Escribí tu respuesta"} maxLength={20000} value={typeof value === "string" && (!q.options.some((o) => (o.value ?? o.label) === value) || q.initialAnswer !== undefined) ? value : ""} onValueChange={(value) => set(q.id, value)} onListeningChange={(active) => setRecording((prev) => prev[q.id] === active ? prev : { ...prev, [q.id]: active })} />}
      </fieldset>;
    })}
    {error && <p role="alert" className="text-fail">{error}</p>}
    <Button type="submit" variant="primary" disabled={busy || listening}>Enviar respuestas</Button>
  </form>;
}
