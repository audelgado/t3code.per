import { useState } from "react";
import { chatDrafts } from "./chatDrafts.ts";

export function useChatDraft(scope: string) {
  const [, render] = useState(0);
  const text = chatDrafts.read(scope);
  const setText = (value: string) => { chatDrafts.write(scope, value); render((n) => n + 1); };
  const clearSent = () => { chatDrafts.clearSent(scope, text); render((n) => n + 1); };
  return [text, setText, clearSent] as const;
}
