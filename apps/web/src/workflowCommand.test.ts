import type { CommandCenterWorkflowInput, CommandCenterWorkflowSlug } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  commandForWorkflow,
  decideWorkflowRun,
  parseWorkflowCommand,
  planWorkflowInputs,
  type WorkflowChoice,
  workflowCommandSuggestions,
  workflowSlugFromCommand,
} from "./workflowCommand";

const input = (name: string, defaultValue?: string): CommandCenterWorkflowInput =>
  ({
    name,
    label: name.toUpperCase(),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  }) as CommandCenterWorkflowInput;

const choice = (
  slug: string,
  inputs: ReadonlyArray<CommandCenterWorkflowInput> = [],
): WorkflowChoice => ({
  slug: slug as CommandCenterWorkflowSlug,
  title: slug.replace(/-/g, " "),
  description: "",
  inputs,
  error: null,
  starter: null,
});

describe("parseWorkflowCommand", () => {
  it("ignores text that is not a /wf command", () => {
    expect(parseWorkflowCommand("fix the login")).toBeNull();
    expect(parseWorkflowCommand("/wfx bugfix")).toBeNull();
    expect(parseWorkflowCommand("/plan")).toBeNull();
  });

  it("reads the slug, quoted and bare inputs, and free text", () => {
    expect(
      parseWorkflowCommand(`  /WF BugFix area=web bug="login fails" note='a b' then more  `),
    ).toEqual({
      slug: "bugfix",
      inputs: { area: "web", bug: "login fails", note: "a b" },
      text: "then more",
    });
  });

  it("allows a bare /wf and keeps URLs as text", () => {
    expect(parseWorkflowCommand("/wf")).toEqual({ slug: "", inputs: {}, text: "" });
    expect(parseWorkflowCommand("/wf bugfix see https://x.dev/?a=b")?.text).toBe(
      "see https://x.dev/?a=b",
    );
  });

  it("unwraps quoted free text and keeps __proto__ as a plain input", () => {
    const parsed = parseWorkflowCommand(`/wf bugfix "login fails" __proto__=x`);
    expect(parsed?.text).toBe("login fails");
    expect(Object.keys(parsed?.inputs ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(parsed?.inputs)).toBe(Object.prototype);
  });
});

describe("planWorkflowInputs", () => {
  const declared = [input("area", "web"), input("bug")];

  it("gives free text to the first input without a default", () => {
    expect(planWorkflowInputs(declared, { inputs: {}, text: "login fails" })).toEqual({
      inputs: { bug: "login fails" },
      missing: [],
      unknown: [],
      leftover: "",
    });
  });

  it("reports missing, unknown and unused text", () => {
    expect(planWorkflowInputs(declared, { inputs: { typo: "x", area: " " }, text: "" })).toEqual({
      inputs: {},
      missing: ["bug"],
      unknown: ["typo"],
      leftover: "",
    });
    expect(planWorkflowInputs([], { inputs: {}, text: "extra" }).leftover).toBe("extra");
  });

  it("falls back to an input with a default once required ones are given", () => {
    expect(planWorkflowInputs(declared, { inputs: { bug: "b" }, text: "api" }).inputs).toEqual({
      bug: "b",
      area: "api",
    });
  });
});

describe("decideWorkflowRun", () => {
  const bugfix = choice("bugfix", [input("bug"), input("area", "web")]);
  const allowed = { canRun: true, error: null };
  const parse = (text: string) => parseWorkflowCommand(text)!;

  it("runs straight away when every input has a value", () => {
    expect(decideWorkflowRun([bugfix], parse("/wf bugfix login fails"), allowed)).toEqual({
      kind: "run",
      choice: bugfix,
      inputs: { bug: "login fails" },
    });
  });

  it("asks when something is missing, unknown, unused or broken", () => {
    expect(decideWorkflowRun([bugfix], parse("/wf bugfix"), allowed)).toEqual({
      kind: "prompt",
      slug: "bugfix",
      values: {},
    });
    expect(decideWorkflowRun([bugfix], parse("/wf bugfix bug=x typo=1"), allowed).kind).toBe(
      "prompt",
    );
    expect(
      decideWorkflowRun([{ ...bugfix, error: "bad JSON" }], parse("/wf bugfix bug=x"), allowed)
        .kind,
    ).toBe("prompt");
    expect(decideWorkflowRun([bugfix], parse("/wf nope"), allowed)).toEqual({
      kind: "prompt",
      slug: "",
      values: {},
    });
  });

  it("refuses without permission or workflows", () => {
    expect(
      decideWorkflowRun([bugfix], parse("/wf bugfix x"), { canRun: false, error: null }),
    ).toMatchObject({ kind: "blocked" });
    expect(
      decideWorkflowRun([], parse("/wf bugfix x"), { canRun: true, error: "offline" }),
    ).toEqual({ kind: "blocked", title: "No workflows to run", description: "offline" });
  });
});

describe("workflowCommandSuggestions", () => {
  const choices = [choice("bugfix", [input("bug"), input("area", "web")]), choice("feature")];

  it("offers /wf, then slugs, then input names not given yet", () => {
    expect(workflowCommandSuggestions("/w", choices)).toEqual([
      { value: "/wf ", label: "Run a workflow" },
    ]);
    expect(workflowCommandSuggestions("/wf bu", choices).map((item) => item.value)).toEqual([
      "/wf bugfix ",
    ]);
    expect(workflowCommandSuggestions("/wf ", choices)).toHaveLength(2);
    expect(workflowCommandSuggestions("/wf bugfix bug=x ", choices)).toEqual([
      { value: "/wf bugfix bug=x area=", label: "AREA (default web)" },
    ]);
    expect(workflowCommandSuggestions("/wf bugfix ar", choices).map((item) => item.value)).toEqual([
      "/wf bugfix area=",
    ]);
  });

  it("stays quiet while a value is typed or the slug is unknown", () => {
    expect(workflowCommandSuggestions("/wf bugfix bug=lo", choices)).toEqual([]);
    expect(workflowCommandSuggestions("/wf nope ", choices)).toEqual([]);
    expect(workflowCommandSuggestions("hello", choices)).toEqual([]);
  });
});

describe("workflow keybinding commands", () => {
  it("round-trips a slug and rejects what the pattern cannot carry", () => {
    expect(commandForWorkflow("release-notes")).toBe("workflow.release-notes.run");
    expect(workflowSlugFromCommand("workflow.release-notes.run")).toBe("release-notes");
    expect(commandForWorkflow("Bad Slug")).toBeNull();
    expect(workflowSlugFromCommand("script.setup.run")).toBeNull();
    expect(workflowSlugFromCommand(null)).toBeNull();
  });
});
