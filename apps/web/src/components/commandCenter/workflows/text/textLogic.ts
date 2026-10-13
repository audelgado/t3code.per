import type { CommandCenterWorkflow } from "@t3tools/contracts";

// Free, deterministic text savings for workflow prompts and skills. Nothing here calls a model;
// "Rewrite shorter" is the only paid path and the user starts it. Hermes-safe (no ES2023 array
// methods), so it can move to client-runtime when mobile edits workflows.

/** Rough tokens for `text`: about four characters each, the same rule the snippet list uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `~840 tokens`, `~1.2k tokens`. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  const thousands = tokens / 1000;
  return `~${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k tokens`;
}

const FENCE = /^\s*(```|~~~)/;
/** Shorter repeated lines (`---`, `}`, `- yes`) are often structure, not instructions. */
const MIN_DUPLICATE_KEY = 12;

/** What makes two lines the same instruction: case, list markers, spacing and end punctuation. */
function instructionKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/[\s.!;:,]+$/, "")
    .trim();
}

export interface CleanupResult {
  readonly text: string;
  /** Repeated instruction lines dropped (blank lines and spacing are not counted). */
  readonly removedLines: number;
}

/**
 * Trailing spaces, runs of spaces inside lines, repeated blank lines and repeated instruction
 * lines go; code fences are copied as they are, and `{{...}}` placeholders are never touched.
 */
export function cleanupText(text: string): CleanupResult {
  const out: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  let removedLines = 0;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      out.push(raw.trimEnd());
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    const line = raw.trimEnd().replace(/(\S)[ \t]{2,}/g, "$1 ");
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const key = instructionKey(line);
    if (key.length >= MIN_DUPLICATE_KEY) {
      if (seen.has(key)) {
        removedLines += 1;
        continue;
      }
      seen.add(key);
    }
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return { text: out.join("\n"), removedLines };
}

/** A paragraph shorter than this costs about as much as the `{{snippet:name}}` that replaces it. */
const MIN_SNIPPET_CHARS = 80;
const PARAGRAPH_BREAK = /(\n[ \t]*\n\s*)/;

const paragraphs = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split(PARAGRAPH_BREAK)
    .filter((_, index) => index % 2 === 0)
    .map((part) => part.trim());

export interface SharedBlock {
  readonly content: string;
  /** How many of the texts contain it. */
  readonly uses: number;
  /** Characters the files lose once every copy is a snippet reference. */
  readonly savedChars: number;
}

/**
 * The paragraph that appears, whole, in the most texts for the biggest saving; null when no
 * paragraph is in two texts or worth a snippet.
 * ponytail: whole paragraphs only; a shared run of several paragraphs becomes one snippet each.
 */
export function findSharedBlock(texts: ReadonlyArray<string>): SharedBlock | null {
  const uses = new Map<string, number>();
  for (const text of texts) {
    for (const paragraph of new Set(paragraphs(text))) {
      if (paragraph.length < MIN_SNIPPET_CHARS || /^\{\{[^{}]+\}\}$/.test(paragraph)) continue;
      uses.set(paragraph, (uses.get(paragraph) ?? 0) + 1);
    }
  }
  let best: SharedBlock | null = null;
  for (const [content, count] of uses) {
    if (count < 2) continue;
    // Each copy becomes a reference of roughly this length.
    const savedChars = count * (content.length - 24) - content.length;
    if (savedChars > 0 && (best === null || savedChars > best.savedChars)) {
      best = { content, uses: count, savedChars };
    }
  }
  return best;
}

/** `text` with every whole-paragraph copy of `content` replaced by `{{snippet:name}}`. */
export function replaceBlock(text: string, content: string, name: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(PARAGRAPH_BREAK)
    .map((part, index) =>
      index % 2 === 0 && part.trim() === content
        ? part.replace(content, `{{snippet:${name}}}`)
        : part,
    )
    .join("");
}

/** A kebab name from the block's first words, unused in `taken`: `review-checklist-2`. */
export function suggestSnippetName(content: string, taken: ReadonlySet<string>): string {
  const words = content.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const base = words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "") || "shared";
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}-${suffix}`;
  return name;
}

export interface WorkflowSnippetExtraction {
  readonly name: string;
  readonly content: string;
  readonly workflow: CommandCenterWorkflow;
  /** Prompts that shared it. Runs cost the same: the runner expands snippets at launch. */
  readonly uses: number;
}

/**
 * Moves the best paragraph shared by several agent prompts into a snippet: the caller saves
 * `content` as snippet `name`, then the returned workflow. Null when there is nothing to share.
 */
export function extractWorkflowSnippet(
  workflow: CommandCenterWorkflow,
  takenNames: ReadonlySet<string>,
): WorkflowSnippetExtraction | null {
  const prompts: string[] = [];
  for (const node of workflow.nodes) if (node.kind === "agent") prompts.push(node.prompt);
  const block = findSharedBlock(prompts);
  if (block === null) return null;
  const name = suggestSnippetName(block.content, takenNames);
  return {
    name,
    content: block.content,
    uses: block.uses,
    workflow: {
      ...workflow,
      nodes: workflow.nodes.map((node) =>
        node.kind === "agent"
          ? { ...node, prompt: replaceBlock(node.prompt, block.content, name) }
          : node,
      ),
    },
  };
}

export interface SkillFile {
  readonly description: string;
  readonly content: string;
}

/** Splits a `SKILL.md` into its frontmatter `description` and the instructions after it. */
export function parseSkillFile(text: string): SkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (match === null) return { description: "", content: text.trim() };
  const content = text.slice(match[0].length).trim();
  const lines = (match[1] ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("description:"));
  if (start === -1) return { description: "", content };
  const value = (lines[start] ?? "").slice("description:".length).trim();
  if (/^[>|][+-]?$/.test(value)) {
    const block: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line !== "" && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    return { description: block.join(value.startsWith(">") ? " " : "\n").trim(), content };
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return { description: parsed, content };
    } catch {
      // Not JSON-compatible escapes; fall through to the plain slice.
    }
    return { description: value.slice(1, -1), content };
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return { description: value.slice(1, -1).replace(/''/g, "'"), content };
  }
  return { description: value, content };
}
