export {
  type CommandCenterAgentState,
  type CommandCenterAgentStatus,
  deriveAgentState,
  latestAssignmentByAgent,
  pendingChildrenByParent,
  threadShellKey,
} from "@t3tools/client-runtime/state/commandCenterDerive";

const MEMORY_PREFIX = /^\s*(remember|record[aá]|guard[aá])\s*:\s*/i;

/** `remember: text` (also `recordá:` / `guardá:`) saves straight to memory. Returns the text, or null. */
export function parseMemoryCommand(input: string): string | null {
  const match = MEMORY_PREFIX.exec(input);
  if (!match) return null;
  const text = input.slice(match[0].length).trim();
  return text.length > 0 ? text : null;
}
