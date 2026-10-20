import { useState } from "react";
import { chatDrafts } from "./chatDrafts.ts";

export function useChatDraft(scope: string) {
  const [, render] = useState(0);
  const draft = chatDrafts.snapshot(scope);
  const setText = (value: string) => { chatDrafts.write(scope, value); render((n) => n + 1); };
  const clearSent = () => { chatDrafts.clearSent(scope, draft); render((n) => n + 1); };
  return [draft.text, setText, clearSent, draft.commandId] as const;
}
