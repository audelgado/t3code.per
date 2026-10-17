import { Mic, Square } from "lucide-react";
import { useEffect, useRef, type ComponentProps } from "react";
import { insertAtCaret, useDictation } from "./dictation.ts";
import { Button } from "./ui/Button.tsx";
import { Textarea } from "./ui/fields.tsx";

/** Dictation edits a draft; callers wait for recording to stop before sending it. */
export function DictationTextarea({ value, onValueChange, onListeningChange, compact = false, autoDictate = false, activateEvent, ...props }: Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref"> & {
  activateEvent?: string;
  compact?: boolean;
  autoDictate?: boolean;
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
  useEffect(() => { if (autoDictate && dictation.supported) dictation.start(); }, []);
  const start = useRef(dictation.start); start.current = dictation.start;
  useEffect(() => { if (!activateEvent) return; const activate = () => { box.current?.focus(); start.current(); }; addEventListener(activateEvent, activate); return () => removeEventListener(activateEvent, activate); }, [activateEvent]);
  return <div className="grid gap-2">
    <Textarea {...props} ref={box} value={value} onChange={(e) => onValueChange(e.target.value)} />
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size={compact ? "icon" : "default"} aria-label={dictation.listening ? "Detener dictado" : "Dictar"} variant={dictation.listening ? "primary" : "outline"} disabled={props.disabled || !dictation.supported} aria-pressed={dictation.listening} onClick={() => dictation.listening ? dictation.stop() : dictation.start()}>
        {dictation.listening ? <Square className="size-4" aria-hidden /> : <Mic className="size-4" aria-hidden />}{!compact && (dictation.listening ? "Detener dictado" : "Dictar")}
      </Button>
      {(!compact || dictation.listening || !dictation.supported) && <span className="text-xs text-muted-fg">{dictation.listening ? "Escuchando… Detén para enviar." : !dictation.supported ? "Puedes usar el micrófono del teclado." : "Dicta, revisa y envía cuando quieras."}</span>}
    </div>
    {dictation.interim && <p aria-live="polite" className="text-sm text-muted-fg">{dictation.interim}</p>}
    {dictation.error && <p role="alert" className="text-sm text-fail">{dictation.error}</p>}
  </div>;
}
