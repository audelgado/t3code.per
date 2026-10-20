export function readDraft<T>(key: string, fallback: T): T {
  try {
    const value = sessionStorage.getItem(key);
    if (value === null) return fallback;
    const parsed: unknown = JSON.parse(value);
    if (typeof fallback === "string") return typeof parsed === "string" ? parsed as T : fallback;
    if (typeof fallback === "object" && fallback !== null) {
      if (typeof parsed !== "object" || parsed === null) return fallback;
      for (const [field, initial] of Object.entries(fallback)) {
        if (typeof (parsed as Record<string, unknown>)[field] !== typeof initial) return fallback;
      }
    }
    return parsed as T;
  }
  catch { return fallback; }
}
export function writeDraft(key: string, value: unknown) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable. */ }
}
export function clearDraft(key: string) {
  try { sessionStorage.removeItem(key); } catch { /* Storage may be unavailable. */ }
}
