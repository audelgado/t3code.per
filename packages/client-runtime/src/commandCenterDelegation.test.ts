import type {
  CommandCenterArtifactId,
  CommandCenterMemoryEntry,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  artifactAgentReference,
  artifactReferenceIds,
  buildOnboardingPrompt,
  buildStepPrompt,
  delegationBranchName,
  delegationWorktreeBootstrap,
  latestHandoffs,
} from "./commandCenterDelegation.ts";

const entry = (id: string, projectId: string, kind: string, createdAt: string, text = id) =>
  ({ id, projectId, kind, createdAt, text }) as unknown as CommandCenterMemoryEntry;
const memory = [
  entry("old", "p1", "handoff", "2026-10-01T00:00:00.000Z"),
  entry("other-project", "p2", "handoff", "2026-10-12T00:00:00.000Z"),
  entry("note", "p1", "note", "2026-10-12T00:00:00.000Z"),
  entry("new", "p1", "handoff", "2026-10-11T00:00:00.000Z", "API ready, tests missing"),
];
const project = "p1" as ProjectId;

describe("latestHandoffs", () => {
  it("keeps only the project's handoffs, newest first, capped", () => {
    expect(latestHandoffs(memory, project).map((item) => item.id)).toEqual(["new", "old"]);
    expect(latestHandoffs(memory, project, 1).map((item) => item.id)).toEqual(["new"]);
  });
});

describe("buildStepPrompt", () => {
  it("includes handoffs and ends with recall and handoff instructions", () => {
    const prompt = buildStepPrompt({
      rolePrompt: "You are QA.",
      step: "Test the API",
      handoffs: latestHandoffs(memory, project),
    });
    expect(prompt.startsWith("You are QA.\n\nTask: Test the API")).toBe(true);
    expect(prompt).toContain("- 2026-10-11: API ready, tests missing");
    const last = prompt.split("\n\n").at(-1) ?? "";
    expect(last).toContain("memory_recall");
    expect(last).toContain('kind "handoff"');
    expect(last).toContain("whoever picks this project up next");
  });

  it("hands off in the reply when the thread runs away from the Command Center home", () => {
    const prompt = buildStepPrompt({
      rolePrompt: "",
      step: "Deploy",
      handoffs: latestHandoffs(memory, project),
      memoryReachable: false,
    });
    const last = prompt.split("\n\n").at(-1) ?? "";
    expect(prompt).toContain("API ready, tests missing");
    expect(last).not.toContain("memory_recall");
    expect(last).not.toContain("memory_save");
    expect(last).toContain('"Handoff:"');
  });

  it("inlines referenced artifacts only where the artifact tools cannot reach", () => {
    const reference = artifactAgentReference({
      id: "art-1" as CommandCenterArtifactId,
      title: "Plan",
      currentVersion: 3,
    });
    expect(artifactReferenceIds(`${reference} and ${reference}then go`)).toEqual(["art-1"]);
    const artifacts = [
      {
        title: "Plan",
        content: `<img src="data:image/png;base64,${"A".repeat(300)}">${"b".repeat(20_100)}`,
      },
    ];
    const remote = buildStepPrompt({
      rolePrompt: "",
      step: reference,
      memoryReachable: false,
      artifacts,
    });
    expect(remote).toContain('Artifact "Plan":\n<img src="data:inline-image">');
    expect(remote).toContain("[… cut at 20000 characters]");
    expect(remote).not.toContain("AAAA");
    expect(buildStepPrompt({ rolePrompt: "", step: reference, artifacts })).not.toContain(
      'Artifact "Plan"',
    );
  });

  it("skips an empty role and handoff block, and trims long handoffs", () => {
    const prompt = buildStepPrompt({ rolePrompt: "", step: "Ship it" });
    expect(prompt.startsWith("Task: Ship it")).toBe(true);
    expect(prompt).not.toContain("Latest handoffs");

    const long = buildStepPrompt({
      rolePrompt: "",
      step: "x",
      handoffs: [entry("long", "p1", "handoff", "2026-10-11T00:00:00.000Z", "a".repeat(600))],
    });
    expect(long).toContain(`${"a".repeat(499)}…`);
    expect(long).not.toContain("a".repeat(500));
  });
});

describe("buildOnboardingPrompt", () => {
  it("is the step prompt for `Onboard <title>` with the project's handoffs", () => {
    const handoffs = latestHandoffs(memory, project);
    expect(buildOnboardingPrompt({ rolePrompt: "Lead.", projectTitle: "Shop", handoffs })).toBe(
      buildStepPrompt({ rolePrompt: "Lead.", step: "Onboard Shop", handoffs }),
    );
  });
});

describe("delegationBranchName", () => {
  it("slugs the agent and task under cc/ with a thread id suffix", () => {
    expect(
      delegationBranchName("Ana", "Fix the login page!", "0b9c1d2e-aaaa-4bbb-8ccc-1234abcd5678"),
    ).toBe("cc/ana-fix-the-login-page-abcd5678");
  });

  it("caps the slug without leaving a trailing separator", () => {
    const branch = delegationBranchName("Bo", `${"word ".repeat(20)}end`, "thread-12345678");
    expect(branch.length).toBeLessThanOrEqual("cc/".length + 40 + "-12345678".length);
    expect(branch).not.toMatch(/--/);
    expect(branch.endsWith("-12345678")).toBe(true);
  });
});

describe("delegationWorktreeBootstrap", () => {
  it("prepares a required worktree from the checkout's HEAD with the given branch", () => {
    expect(
      delegationWorktreeBootstrap({ worktree: true, projectCwd: "/repo", branch: "cc/x-1" }),
    ).toEqual({
      prepareWorktree: {
        projectCwd: "/repo",
        baseBranch: "HEAD",
        branch: "cc/x-1",
        requireWorktree: true,
      },
      runSetupScript: true,
    });
  });

  it("adds nothing when the step runs in the project checkout", () => {
    expect(
      delegationWorktreeBootstrap({ worktree: false, projectCwd: "/repo", branch: "cc/x-1" }),
    ).toEqual({});
  });
});
