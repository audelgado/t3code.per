type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Mantiene un respaldo en memoria cuando el navegador bloquea el almacenamiento. */
export function createChatDraftStore(storage: () => DraftStorage | undefined) {
  const memory = new Map<string, string>();
  const key = (scope: string) => `cc.chat.draft:${scope}`;
  const read = (scope: string) => {
    if (memory.has(scope)) return memory.get(scope)!;
    let value = "";
    try { value = storage()?.getItem(key(scope)) ?? ""; } catch { /* Usa el respaldo en memoria. */ }
    memory.set(scope, value);
    return value;
  };
  const write = (scope: string, text: string) => {
    memory.set(scope, text);
    try { if (text) storage()?.setItem(key(scope), text); else storage()?.removeItem(key(scope)); } catch { /* El borrador sigue en memoria. */ }
  };
  return { read, write, clearSent: (scope: string, sent: string) => { if (read(scope) === sent) write(scope, ""); } };
}

export const chatDrafts = createChatDraftStore(() => typeof sessionStorage === "undefined" ? undefined : sessionStorage);
