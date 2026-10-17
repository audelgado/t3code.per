// Voice input through the browser's SpeechRecognition (Spanish, es-AR). Not offered where it is missing (e.g. Firefox).
import { useEffect, useRef, useState } from "react";

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type Ctor = new () => Recognition;

/** Result lists are cumulative and may replay final entries. Commit each index once per session. */
export function recognitionTranscript() {
  const committed = new Set<number>();
  return (results: Parameters<NonNullable<Recognition["onresult"]>>[0]["results"]) => {
    const finals: string[] = [];
    const partial: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result || committed.has(i)) continue;
      if (result.isFinal) {
        committed.add(i);
        finals.push(result[0].transcript.trim());
      } else partial.push(result[0].transcript.trim());
    }
    return { final: finals.filter(Boolean).join(" "), interim: partial.filter(Boolean).join(" ") };
  };
}

const ctor = (): Ctor | null => {
  const w = window as Window & { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const denied = "Se denegó el permiso del micrófono. Habilitalo en los ajustes del sitio del navegador.";
const errors: Record<string, string | null> = {
  aborted: null,
  "not-allowed": denied,
  "service-not-allowed": denied,
  network: "El dictado necesita conexión a internet.",
  "audio-capture": "No se encontró un micrófono.",
  "no-speech": "No se escuchó nada. Probá de nuevo.",
  "language-not-supported": "El navegador no soporta dictado en español.",
};

/** Inserts recognized text at the caret without joining neighboring words. */
export function insertAtCaret(value: string, start: number, end: number, text: string) {
  const words = text.trim();
  if (!words) return { value, caret: start };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) && !/^[,.;:!?)}\]]/.test(words) ? " " : "";
  const trail = after && !/^\s|^[,.;:!?)}\]]/.test(after) ? " " : "";
  return { value: `${before}${lead}${words}${trail}${after}`, caret: before.length + lead.length + words.length + trail.length };
}

/**
 * `onFinal` receives each finished phrase. It stops by itself when the page is hidden or loses focus
 * (the mic must never stay open in the background) and on unmount.
 */
export function useDictation(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const active = useRef<Recognition | null>(null);
  const interimRef = useRef("");
  const emit = useRef(onFinal);
  emit.current = onFinal;
  const supported = typeof window !== "undefined" && ctor() !== null;

  const stop = () => {
    const r = active.current;
    if (!r) return;
    active.current = null;
    r.onresult = r.onerror = r.onend = null;
    // abort() drops the phrase still being recognized: keep what was heard so far.
    const pending = interimRef.current.trim();
    interimRef.current = "";
    if (pending) emit.current(pending);
    r.abort();
    setListening(false);
    setInterim("");
  };

  /** es-AR first; a browser that rejects it retries once with its own language. */
  const begin = (lang: string) => {
    const C = ctor();
    if (!C || active.current) return;
    // A form can contain several voice fields; only one owns the microphone.
    window.dispatchEvent(new Event("cc:dictation-start"));
    const r = new C();
    active.current = r;
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;
    setError(null);
    const transcript = recognitionTranscript();
    r.onresult = (e) => {
      if (active.current !== r) return;
      const next = transcript(e.results);
      // Update before emitting: stop() must never flush an already committed phrase.
      interimRef.current = next.interim;
      setInterim(next.interim);
      if (next.final) emit.current(next.final);
    };
    r.onerror = (e) => {
      if (e.error === "language-not-supported" && navigator.language && lang !== navigator.language) {
        stop();
        begin(navigator.language);
        return;
      }
      setError(e.error in errors ? errors[e.error]! : "El dictado se detuvo. Probá de nuevo.");
    };
    r.onend = () => {
      if (active.current === r) stop();
    };
    try {
      r.start();
      setListening(true);
    } catch {
      stop();
      setError("No se pudo iniciar el dictado. Probá de nuevo.");
    }
  };
  const start = () => begin("es-AR");

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const leave = () => stopRef.current();
    const hidden = () => document.hidden && leave();
    addEventListener("blur", leave);
    addEventListener("cc:dictation-start", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      removeEventListener("blur", leave);
      removeEventListener("cc:dictation-start", leave);
      document.removeEventListener("visibilitychange", hidden);
      leave();
    };
  }, []);

  return { supported, listening, interim, error, start, stop };
}
