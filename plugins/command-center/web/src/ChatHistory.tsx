import type { ChatMessage } from "../../server/types.ts";

/** A continuous transcript, shared by project chats and thread detail. */
export function ChatHistory({ messages }: { messages: Pick<ChatMessage, "id" | "role" | "text">[] }) {
  return <div role="log" aria-label="Conversación" className="grid gap-5">{messages.map((m) => <div key={m.id} aria-label={m.role === "user" ? "Tu mensaje" : "Mensaje del agente"} className={m.role === "user" ? "ml-auto max-w-[90%] rounded-2xl bg-soft px-4 py-3" : "min-w-0 py-1"}><p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{m.text}</p></div>)}</div>;
}
