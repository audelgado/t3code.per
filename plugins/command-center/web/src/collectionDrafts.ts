type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function matchesCollectionDraft(value: unknown, initial: unknown): boolean {
  if (initial === null) return value === null || typeof value === "string" || (typeof value === "object" && !Array.isArray(value));
  if (Array.isArray(initial)) return Array.isArray(value) && value.every((item) => matchesCollectionDraft(item, initial[0] ?? ""));
  if (typeof initial === "object" && typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.entries(initial).every(([key, field]) => matchesCollectionDraft((value as Record<string, unknown>)[key], field));
  }
  if (typeof initial === "object") return false;
  return typeof value === typeof initial;
}

/** La memoria tiene prioridad para que un fallo de cuota no restaure una copia antigua. */
export function createCollectionDraftStore(storage: () => DraftStorage | undefined) {
  const memory = new Map<string, string | null>();
  const key = (scope: string) => `cc.draft.${scope}`;
  const read = <T>(scope: string, initial: T, accept?: (value: unknown) => boolean): T => {
    try {
      const raw = memory.has(scope) ? memory.get(scope) : storage()?.getItem(key(scope));
      if (raw == null) return initial;
      const value: unknown = JSON.parse(raw);
      if (accept ? !accept(value) : !matchesCollectionDraft(value, initial)) return initial;
      memory.set(scope, raw);
      return value as T;
    } catch { return initial; }
  };
  const clear = (scope: string) => {
    // La marca vacía impide resucitar almacenamiento obsoleto si removeItem falla.
    memory.set(scope, null);
    try { storage()?.removeItem(key(scope)); } catch { /* El respaldo ya está vacío. */ }
  };
  const write = (scope: string, value: unknown) => {
    if (value === null) { clear(scope); return; }
    const raw = JSON.stringify(value);
    memory.set(scope, raw);
    try { storage()?.setItem(key(scope), raw); } catch { /* Conserva la versión actual en memoria. */ }
  };
  return { read, write, clear };
}

export const collectionDrafts = createCollectionDraftStore(() => typeof sessionStorage === "undefined" ? undefined : sessionStorage);
