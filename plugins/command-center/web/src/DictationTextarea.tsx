import { ArrowUp, Ellipsis, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";
import { insertAtCaret, useDictation } from "./dictation.ts";
import { Button } from "./ui/Button.tsx";
import { Textarea } from "./ui/fields.tsx";
import { isMessageSubmitKey } from "./messageComposer.ts";

/** Dictation edits a draft; callers wait for recording to stop before sending it. */
export function DictationTextarea({ value, onValueChange, onListeningChange, compact = false, autoDictate = false, activateEvent, send, footer, ...props }: Omit<ComponentProps<"textarea">, "value" | "onChange" | "ref"> & {
  activateEvent?: string;
  compact?: boolean;
  autoDictate?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onListeningChange: (listening: boolean) => void;
  send?: { label?: string; disabled?: boolean; busy?: boolean };
  footer?: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const feedbackId = useId();
  const shortcutId = useId();
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
  const fit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    const height = el.scrollHeight;
    el.style.height = `${Math.min(height, 192)}px`;
    el.style.overflowY = height > 192 ? "auto" : "hidden";
  }, []);
  useLayoutEffect(fit, [value, props.rows, fit]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      addEventListener("resize", fit);
      return () => removeEventListener("resize", fit);
    }
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === el.clientWidth) return;
      width = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);
  useEffect(() => { if (props.disabled) dictation.stop(); }, [props.disabled]);
  useEffect(() => { if (autoDictate && dictation.supported) dictation.start(); }, []);
  const start = useRef(dictation.start); start.current = dictation.start;
  useEffect(() => { if (!activateEvent) return; const activate = () => { box.current?.focus(); start.current(); }; addEventListener(activateEvent, activate); return () => removeEventListener(activateEvent, activate); }, [activateEvent]);
  const busy = props.disabled || !!send?.busy;
  const canSend = !!send && !busy && !send.disabled && !dictation.listening && !!value.trim();
  const micLabel = dictation.listening ? "Detener dictado" : dictation.supported ? "Dictar mensaje" : "Dictado no disponible. Usa el micrófono del teclado.";
  const feedback = dictation.error || (dictation.listening ? dictation.interim || "Escuchando… Detén el dictado para revisar y enviar." : send?.busy ? "Procesando…" : !dictation.supported ? "Dictado no disponible aquí. Usa el micrófono del teclado." : "");
  return <div className="grid min-w-0 gap-1.5">
    <div className="rounded-[26px] border border-line bg-panel p-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
      <div className="flex min-w-0 items-end gap-1">
        <Textarea {...props} variant="composer" ref={box} rows={props.rows ?? (compact ? 1 : 2)} value={value} disabled={busy} aria-describedby={[props["aria-describedby"], feedbackId, send ? shortcutId : undefined].filter(Boolean).join(" ")} enterKeyHint={send ? "send" : props.enterKeyHint} onChange={(e) => onValueChange(e.target.value)} onKeyDown={(e) => {
          props.onKeyDown?.(e);
          if (!send || e.defaultPrevented || !isMessageSubmitKey({ key: e.key, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) return;
          e.preventDefault();
          if (canSend) e.currentTarget.form?.requestSubmit();
        }} />
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="composer" aria-label={micLabel} title={micLabel} variant={dictation.listening ? "danger" : "ghost"} disabled={busy || !dictation.supported} aria-pressed={dictation.listening} onClick={() => dictation.listening ? dictation.stop() : dictation.start()}>
            {dictation.listening ? <Square className="size-[18px]" fill="currentColor" aria-hidden /> : <Mic className="size-5" aria-hidden />}
          </Button>
          {send && <Button type="submit" size="composer" variant="primary" disabled={!canSend} aria-label={send.busy ? "Procesando solicitud" : send.label ?? "Enviar mensaje"} title={send.label ?? "Enviar mensaje"} aria-busy={send.busy || undefined}>{send.busy ? <Ellipsis className="size-5" aria-hidden /> : <ArrowUp className="size-5" aria-hidden />}</Button>}
        </div>
      </div>
      {feedback && <p id={feedbackId} role={dictation.error ? "alert" : "status"} className={`px-3 pb-2 text-xs break-words ${dictation.error ? "text-fail" : "text-muted-fg"}`}>{dictation.listening && !dictation.error && <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full bg-fail" />}{feedback}</p>}
      {footer && <div className="px-1 pt-1 pb-1">{footer}</div>}
    </div>
    {!feedback && <span id={feedbackId} className="sr-only">{dictation.supported ? "Puedes escribir o dictar y revisar antes de enviar." : "Puedes usar el micrófono del teclado para dictar."}</span>}
    {send && <span id={shortcutId} className="sr-only">Enter para enviar. Mayús y Enter para una nueva línea.</span>}
  </div>;
}
