import { isElectron } from "~/env";

export interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
export interface WebRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((event: {
        readonly resultIndex: number;
        readonly results: ArrayLike<RecognitionResult>;
      }) => void)
    | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
  stop: () => void;
}
type RecognitionConstructor = new () => WebRecognition;

export function getSpeechRecognitionCtor() {
  if (typeof window === "undefined") return null;
  const browser = window as Window & {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

export const supportsWebDictation = (electron: boolean, hasRecognition: boolean) =>
  !electron && hasRecognition;
export const isWebDictationSupported = () =>
  supportsWebDictation(isElectron, getSpeechRecognitionCtor() !== null);
export const dictationLanguage = () => navigator.language || "es-AR";

export function dictationErrorMessage(code: string) {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone permission denied. Allow it in the browser's site settings.";
    case "network":
      return "Dictation needs a network connection.";
    case "audio-capture":
      return "No microphone found.";
    case "no-speech":
      return "Didn't catch that. Try again.";
    default:
      return "Dictation stopped. Try again.";
  }
}

/** Inserts recognized text without joining neighboring words. */
export function insertAtCaret(value: string, start: number, end: number, text: string) {
  const words = text.trim();
  if (!words) return { value, caret: start };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leading = before && !/\s$/.test(before) && !/^[,.;:!?)}\]]/.test(words) ? " " : "";
  const trailing = after && !/^\s|^[,.;:!?)}\]]/.test(after) ? " " : "";
  const insertion = `${leading}${words}${trailing}`;
  return { value: `${before}${insertion}${after}`, caret: before.length + insertion.length };
}

export function insertIntoInput(inputId: string, value: string, text: string) {
  const node = document.getElementById(inputId);
  const input =
    node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : null;
  const inserted = insertAtCaret(
    value,
    input?.selectionStart ?? value.length,
    input?.selectionEnd ?? value.length,
    text,
  );
  if (input)
    requestAnimationFrame(() => {
      if (!input.isConnected) return;
      input.focus();
      input.setSelectionRange(inserted.caret, inserted.caret);
    });
  return inserted.value;
}
