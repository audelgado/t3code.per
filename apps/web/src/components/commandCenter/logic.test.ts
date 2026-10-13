import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CommandCenterAgentId,
  CommandCenterAssignmentId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CommandCenterAssignment,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveAgentState, latestAssignmentByAgent, parseMemoryCommand } from "./logic";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

const assignment = (
  id: string,
  createdAt: string,
  finishedAt: string | null = null,
): CommandCenterAssignment => ({
  id: CommandCenterAssignmentId.make(id),
  agentId: CommandCenterAgentId.make("agent"),
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  sectionId: null,
  task: "Build it",
  createdAt,
  finishedAt,
});

// Only the fields the derivation reads; the rest of the shell is irrelevant here.
const shell = (patch: {
  status?: NonNullable<EnvironmentThreadShell["runtime"]>["status"];
  usageLimitResetAt?: string | null;
  pending?: boolean;
}) =>
  ({
    hasPendingApprovals: patch.pending ?? false,
    hasPendingUserInput: false,
    runtime: {
      status: patch.status ?? "running",
      activeRunId: null,
      activityStartedAt: "2026-10-13T11:00:00.000Z",
      providerInstanceId: "codex",
      providerName: null,
      lastError: null,
      usageLimitResetAt: patch.usageLimitResetAt ?? null,
      updatedAt: "2026-10-13T11:00:00.000Z",
    },
  }) as unknown as EnvironmentThreadShell;

describe("deriveAgentState", () => {
  const open = assignment("a", "2026-10-13T10:00:00.000Z");

  it("reads idle without an open assignment or a visible thread", () => {
    expect(deriveAgentState(null, null, NOW).status).toBe("idle");
    expect(deriveAgentState(open, null, NOW).status).toBe("idle");
    expect(
      deriveAgentState(assignment("a", open.createdAt, "2026-10-13T11:00:00.000Z"), shell({}), NOW)
        .status,
    ).toBe("idle");
  });

  it("ranks a pending question over a limit over a failure over a run", () => {
    const future = "2026-10-13T13:00:00.000Z";
    expect(
      deriveAgentState(open, shell({ pending: true, usageLimitResetAt: future }), NOW).status,
    ).toBe("waiting");
    expect(
      deriveAgentState(open, shell({ status: "failed", usageLimitResetAt: future }), NOW).status,
    ).toBe("limited");
    expect(
      deriveAgentState(
        open,
        shell({ status: "failed", usageLimitResetAt: "2026-10-13T11:00:00.000Z" }),
        NOW,
      ).status,
    ).toBe("blocked");
    const working = deriveAgentState(open, shell({ status: "running" }), NOW);
    expect(working).toMatchObject({ status: "working", since: "2026-10-13T11:00:00.000Z" });
    expect(deriveAgentState(open, shell({ status: "completed" }), NOW)).toMatchObject({
      status: "idle",
      since: null,
    });
  });
});

describe("latestAssignmentByAgent", () => {
  it("keeps the newest assignment per agent", () => {
    const latest = latestAssignmentByAgent([
      assignment("old", "2026-10-12T10:00:00.000Z"),
      assignment("new", "2026-10-13T10:00:00.000Z"),
      assignment("mid", "2026-10-12T20:00:00.000Z"),
    ]);
    expect(latest.get(CommandCenterAgentId.make("agent"))?.id).toBe("new");
  });
});

describe("parseMemoryCommand", () => {
  it("accepts the English and Spanish prefixes, with or without accents", () => {
    expect(parseMemoryCommand("remember: ship on Friday")).toBe("ship on Friday");
    expect(parseMemoryCommand("  Recordá:  cliente pide logo")).toBe("cliente pide logo");
    expect(parseMemoryCommand("guarda: deploy listo")).toBe("deploy listo");
  });

  it("ignores ordinary requests and empty notes", () => {
    expect(parseMemoryCommand("build the landing page, then deploy")).toBeNull();
    expect(parseMemoryCommand("remember:   ")).toBeNull();
    expect(parseMemoryCommand("please remember: this")).toBeNull();
  });
});
