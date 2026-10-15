// Voice input through the browser's SpeechRecognition. Not offered where it is missing (e.g. Firefox).
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

const ctor = (): Ctor | null => {
  const w = window as Window & { SpeechRecognition?: Ctor; webkitSpeechRecognition?: Ctor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

const errors: Record<string, string | null> = {
  aborted: null,
  "not-allowed": "Microphone permission denied. Allow it in the browser's site settings.",
  "service-not-allowed": "Microphone permission denied. Allow it in the browser's site settings.",
  network: "Dictation needs a network connection.",
  "audio-capture": "No microphone found.",
  "no-speech": "Didn't catch that. Try again.",
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
  const emit = useRef(onFinal);
  emit.current = onFinal;
  const supported = typeof window !== "undefined" && ctor() !== null;

  const stop = () => {
    const r = active.current;
    if (!r) return;
    active.current = null;
    r.onresult = r.onerror = r.onend = null;
    r.abort();
    setListening(false);
    setInterim("");
  };

  const start = () => {
    const C = ctor();
    if (!C || active.current) return;
    const r = new C();
    active.current = r;
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    setError(null);
    r.onresult = (e) => {
      let partial = "";
      const finals: string[] = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) finals.push(res[0].transcript);
        else partial += res[0].transcript;
      }
      if (finals.length) emit.current(finals.join(" "));
      setInterim(partial);
    };
    r.onerror = (e) => setError(e.error in errors ? errors[e.error]! : "Dictation stopped. Try again.");
    r.onend = () => {
      if (active.current === r) active.current = null;
      setListening(false);
      setInterim("");
    };
    try {
      r.start();
      setListening(true);
    } catch {
      stop();
      setError("Could not start dictation. Try again.");
    }
  };

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    const leave = () => stopRef.current();
    const hidden = () => document.hidden && leave();
    addEventListener("blur", leave);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", hidden);
      leave();
    };
  }, []);

  return { supported, listening, interim, error, start, stop };
}
