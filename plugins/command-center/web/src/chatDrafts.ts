type DraftStorage = Pick<Storage, "getItem" | "setItem">;
export type ChatDraft = Readonly<{ text: string; commandId: string }>;
const PREFIX = "cc.chat.draft.v1:";

/** Conserva texto e identidad del envío incluso si se pierde la respuesta del servidor. */
export function createChatDraftStore(storage: () => DraftStorage | undefined) {
  const memory = new Map<string, ChatDraft>();
  const key = (scope: string) => `cc.chat.draft:${scope}`;
  const save = (scope: string, draft: ChatDraft) => {
    memory.set(scope, draft);
    try { storage()?.setItem(key(scope), PREFIX + JSON.stringify(draft)); } catch { /* El borrador sigue en memoria. */ }
    return draft;
  };
  const snapshot = (scope: string): ChatDraft => {
    const cached = memory.get(scope);
    if (cached) return cached;
    let text = "";
    try { text = storage()?.getItem(key(scope)) ?? ""; } catch { /* Usa el respaldo en memoria. */ }
    if (text.startsWith(PREFIX)) {
      try {
        const draft: unknown = JSON.parse(text.slice(PREFIX.length));
        if (draft && typeof draft === "object" && "text" in draft && typeof draft.text === "string" && "commandId" in draft && typeof draft.commandId === "string" && draft.commandId) {
          const restored = { text: draft.text, commandId: draft.commandId };
          memory.set(scope, restored);
          return restored;
        }
      } catch { /* Conserva como texto los borradores anteriores. */ }
    }
    return save(scope, { text, commandId: crypto.randomUUID() });
  };
  const write = (scope: string, text: string) => save(scope, { text, commandId: crypto.randomUUID() });
  return {
    snapshot,
    read: (scope: string) => snapshot(scope).text,
    write,
    clearSent: (scope: string, sent: ChatDraft) => {
      if (snapshot(scope).commandId === sent.commandId) write(scope, "");
    },
  };
}

export const chatDrafts = createChatDraftStore(() => typeof sessionStorage === "undefined" ? undefined : sessionStorage);
