import { Mic, Square } from "lucide-react";
import { useEffect, useRef, type ComponentProps } from "react";
import { insertAtCaret, useDictation } from "./dictation.ts";
import { Button } from "./ui/Button.tsx";
import { Textarea } from "./ui/fields.tsx";

/** Dictation edits a draft; callers wait for recording to stop before sending it. */
export function DictationTextarea({ value, onValueChange, onListeningChange, ...props }: Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref"> & {
  value: string;
  onValueChange: (value: string) => void;
  onListeningChange: (listening: boolean) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const current = useRef(value);
  current.current = value;
  const reportListening = useRef(onListeningChange);
  reportListening.current = onListeningChange;
  const dictation = useDictation((text) => {
    const el = box.current;
    const result = insertAtCaret(current.current, el?.selectionStart ?? current.current.length, el?.selectionEnd ?? current.current.length, text);
    const next = result.value.slice(0, props.maxLength);
    current.current = next;
    onValueChange(next);
    requestAnimationFrame(() => el?.setSelectionRange(Math.min(result.caret, next.length), Math.min(result.caret, next.length)));
  });
  useEffect(() => { reportListening.current(dictation.listening); }, [dictation.listening]);
  useEffect(() => { if (props.disabled) dictation.stop(); }, [props.disabled]);
  return <div className="grid gap-2">
    <Textarea {...props} ref={box} value={value} onChange={(e) => onValueChange(e.target.value)} />
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant={dictation.listening ? "primary" : "outline"} disabled={props.disabled || !dictation.supported} aria-pressed={dictation.listening} onClick={() => dictation.listening ? dictation.stop() : dictation.start()}>
        {dictation.listening ? <Square className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}{dictation.listening ? "Detener dictado" : "Dictar"}
      </Button>
      <span className="text-xs text-muted-fg">{dictation.listening ? "Detené el dictado para revisar y enviar." : !dictation.supported ? "Podés usar el micrófono del teclado de tu celular." : "Dictá, revisá y enviá cuando quieras."}</span>
    </div>
    {dictation.interim && <p aria-live="polite" className="text-sm text-muted-fg">{dictation.interim}</p>}
    {dictation.error && <p role="alert" className="text-sm text-fail">{dictation.error}</p>}
  </div>;
}
