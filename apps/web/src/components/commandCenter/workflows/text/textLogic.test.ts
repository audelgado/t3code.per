import {
  CommandCenterWorkflowNodeId,
  CommandCenterWorkflowSlug,
  type CommandCenterWorkflow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanupText,
  estimateTokens,
  extractWorkflowSnippet,
  findSharedBlock,
  formatTokens,
  parseSkillFile,
  suggestSnippetName,
} from "./textLogic";

const SHARED =
  "Follow the repository conventions in AGENTS.md, run the scoped checks for the files you touched, and never push.";

describe("estimateTokens", () => {
  it("counts about four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
    expect(formatTokens(840)).toBe("~840 tokens");
    expect(formatTokens(1200)).toBe("~1.2k tokens");
    expect(formatTokens(2000)).toBe("~2k tokens");
    expect(formatTokens(15_400)).toBe("~15k tokens");
  });
});

describe("cleanupText", () => {
  it("drops repeated instructions, spacing and blank runs but keeps placeholders", () => {
    const result = cleanupText(
      [
        "",
        "Fix {{input:bug}}   in the parser.  ",
        "- Write a failing test first.",
        "",
        "",
        "",
        "* write a failing test first",
        "1. Write a FAILING test first!",
        "---",
        "---",
        "",
      ].join("\r\n"),
    );
    expect(result.text).toBe(
      ["Fix {{input:bug}} in the parser.", "- Write a failing test first.", "", "---", "---"].join(
        "\n",
      ),
    );
    expect(result.removedLines).toBe(2);
  });

  it("copies code fences untouched", () => {
    const fenced = ["```ts", "const a  =  1;   ", "", "", "const a  =  1;   ", "```"].join("\n");
    expect(cleanupText(`Run this:\n${fenced}`).text).toBe(`Run this:\n${fenced}`);
  });

  it("is idempotent", () => {
    const once = cleanupText("A  line that repeats itself\n\n\nA line that repeats itself.").text;
    expect(cleanupText(once).text).toBe(once);
  });
});

describe("findSharedBlock", () => {
  it("finds a whole paragraph shared by several prompts", () => {
    const block = findSharedBlock([`Plan it.\n\n${SHARED}`, `${SHARED}\n\nShip it.`, "Other."]);
    expect(block?.content).toBe(SHARED);
    expect(block?.uses).toBe(2);
  });

  it("ignores short or single-use paragraphs and existing references", () => {
    expect(findSharedBlock(["Keep it short.\n\nx", "Keep it short.\n\ny"])).toBeNull();
    expect(findSharedBlock([SHARED, "Something else entirely."])).toBeNull();
    expect(findSharedBlock(["{{snippet:rules}}", "{{snippet:rules}}"])).toBeNull();
  });
});

describe("suggestSnippetName", () => {
  it("builds a free kebab name from the first words", () => {
    expect(suggestSnippetName(SHARED, new Set())).toBe("follow-the-repository-conventions");
    expect(suggestSnippetName(SHARED, new Set(["follow-the-repository-conventions"]))).toBe(
      "follow-the-repository-conventions-2",
    );
    expect(suggestSnippetName("¿¡!", new Set())).toBe("shared");
  });
});

describe("extractWorkflowSnippet", () => {
  const node = (id: string, prompt: string) => ({
    id: CommandCenterWorkflowNodeId.make(id),
    kind: "agent" as const,
    prompt,
    skills: [],
    worktree: false,
    outputs: "text" as const,
  });
  const workflow: CommandCenterWorkflow = {
    slug: CommandCenterWorkflowSlug.make("feature"),
    title: "Feature",
    description: "",
    inputs: [],
    nodes: [
      node("plan", `Plan {{input:goal}}.\n\n${SHARED}`),
      node("build", `${SHARED}\r\n\r\nBuild it.`),
      { id: CommandCenterWorkflowNodeId.make("check"), kind: "gate", check: "tests" },
    ],
    edges: [],
    layout: {},
  };

  it("replaces every copy with a snippet reference", () => {
    const result = extractWorkflowSnippet(workflow, new Set(["follow-the-repository-conventions"]));
    expect(result?.name).toBe("follow-the-repository-conventions-2");
    expect(result?.content).toBe(SHARED);
    expect(result?.uses).toBe(2);
    expect(result?.workflow.nodes.map((n) => (n.kind === "agent" ? n.prompt : n.kind))).toEqual([
      "Plan {{input:goal}}.\n\n{{snippet:follow-the-repository-conventions-2}}",
      "{{snippet:follow-the-repository-conventions-2}}\n\nBuild it.",
      "gate",
    ]);
  });

  it("returns null when nothing is shared", () => {
    expect(extractWorkflowSnippet({ ...workflow, nodes: [node("a", SHARED)] }, new Set())).toBe(
      null,
    );
  });
});

describe("parseSkillFile", () => {
  it("reads plain, quoted and folded descriptions", () => {
    expect(parseSkillFile("---\nname: a\ndescription: Use it.\n---\n\nBody\n")).toEqual({
      description: "Use it.",
      content: "Body",
    });
    expect(parseSkillFile('---\nname: a\ndescription: "Say \\"hi\\": now"\n---\nBody')).toEqual({
      description: 'Say "hi": now',
      content: "Body",
    });
    expect(parseSkillFile("---\ndescription: 'It''s fine'\n---\nBody").description).toBe(
      "It's fine",
    );
    expect(
      parseSkillFile("---\ndescription: >\n  Two\n  lines\nname: a\n---\nBody").description,
    ).toBe("Two lines");
  });

  it("treats a file without frontmatter as all instructions", () => {
    expect(parseSkillFile("  Just do it.\n")).toEqual({ description: "", content: "Just do it." });
  });
});
