import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  dictationErrorMessage,
  dictationLanguage,
  getSpeechRecognitionCtor,
  isWebDictationSupported,
  type WebRecognition,
} from "./webDictation";

let stopActive: (() => void) | null = null;
let activeRecognition: WebRecognition | null = null;

export function useWebDictation(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognition = useRef<WebRecognition | null>(null);
  const emit = useEffectEvent(onFinal);
  const supported = isWebDictationSupported();

  const stop = () => {
    const active = recognition.current;
    if (!active) return;
    active.onresult = null;
    active.onerror = null;
    active.onend = null;
    recognition.current = null;
    if (activeRecognition === active) {
      stopActive = null;
      activeRecognition = null;
    }
    active.abort();
    setListening(false);
    setInterim("");
  };

  const start = () => {
    const Ctor = getSpeechRecognitionCtor();
    if (!supported || !Ctor || recognition.current) return;
    stopActive?.();
    const active = new Ctor();
    recognition.current = active;
    activeRecognition = active;
    stopActive = stop;
    active.continuous = true;
    active.interimResults = true;
    active.lang = dictationLanguage();
    setError(null);
    active.onresult = (event) => {
      let partial = "";
      const finals: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (!result) continue;
        if (result.isFinal) finals.push(result[0].transcript);
        else partial += result[0].transcript;
      }
      if (finals.length) emit(finals.join(" "));
      setInterim(partial);
    };
    active.onerror = (event) => setError(dictationErrorMessage(event.error));
    active.onend = () => {
      recognition.current = null;
      if (activeRecognition === active) {
        stopActive = null;
        activeRecognition = null;
      }
      setListening(false);
      setInterim("");
    };
    try {
      active.start();
      setListening(true);
    } catch {
      stop();
      setError("Could not start dictation. Try again.");
    }
  };

  const stopOnLeave = useEffectEvent(stop);
  useEffect(() => {
    const blur = () => stopOnLeave();
    const hidden = () => {
      if (document.hidden) stopOnLeave();
    };
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", hidden);
      stopOnLeave();
    };
  }, []);
  return { supported, listening, interim, error, start, stop };
}
