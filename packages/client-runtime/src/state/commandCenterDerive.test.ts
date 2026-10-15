// @effect-diagnostics globalDate:off -- Fixtures use local calendar days like the derivation.
import {
  CommandCenterAgentId,
  type CommandCenterSection,
  type CommandCenterSnapshot,
  type CommandCenterWorkflowRun,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CommandCenterAgentState,
  commandCenterAlerts,
  countSectionDeadlines,
  daysUntil,
  deriveAttention,
  deriveWorkingThreads,
  STUCK_AFTER_MINUTES,
} from "./commandCenterDerive.ts";
import type { EnvironmentThreadShell } from "./models.ts";

const now = new Date(2026, 9, 13, 12, 0).getTime();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const local = EnvironmentId.make("local");

const EMPTY: CommandCenterSnapshot = {
  agentProfiles: [],
  teams: [],
  assignments: [],
  sections: [],
  memory: [],
  income: [],
  costs: [],
};

function shell(
  id: string,
  patch: Partial<{
    hasPendingApprovals: boolean;
    hasPendingUserInput: boolean;
    hasActionableProposedPlan: boolean;
    interactionMode: "default" | "plan";
    running: boolean;
    archivedAt: string | null;
    snoozedUntil: string | null;
    unsettledAt: string | null;
    subagent: boolean;
  }> = {},
) {
  const updatedAt = minutesAgo(5);
  return {
    environmentId: local,
    id: ThreadId.make(id),
    createdAt: minutesAgo(600),
    updatedAt,
    unsettledAt: patch.unsettledAt ?? null,
    archivedAt: patch.archivedAt ?? null,
    deletedAt: null,
    snoozedUntil: patch.snoozedUntil ?? null,
    snoozedAt: patch.snoozedUntil ? minutesAgo(60) : null,
    hasPendingApprovals: patch.hasPendingApprovals ?? false,
    hasPendingUserInput: patch.hasPendingUserInput ?? false,
    hasActionableProposedPlan: patch.hasActionableProposedPlan ?? false,
    interactionMode: patch.interactionMode ?? "default",
    latestRun: null,
    lineage: {
      parentThreadId: patch.subagent ? ThreadId.make("parent") : null,
      relationshipToParent: patch.subagent ? "subagent" : null,
    },
    runtime: patch.running
      ? {
          status: "running",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt,
        }
      : null,
  } as unknown as EnvironmentThreadShell;
}

const attention = (shells: ReadonlyArray<EnvironmentThreadShell>, snapshot = EMPTY) =>
  deriveAttention({ shells, snapshot, environments: [], primaryEnvironmentId: local, now });
const keys = (shells: ReadonlyArray<EnvironmentThreadShell>, snapshot = EMPTY) =>
  attention(shells, snapshot).map((item) => item.key);

describe("daysUntil", () => {
  it("counts calendar days from today", () => {
    const lateEvening = new Date(2026, 9, 13, 23, 30).getTime();
    expect(daysUntil("2026-10-13", lateEvening)).toBe(0);
    expect(daysUntil("2026-10-20", lateEvening)).toBe(7);
    expect(daysUntil("2026-10-12", lateEvening)).toBe(-1);
  });
});

describe("countSectionDeadlines", () => {
  it("keeps overdue sections out of the next 7 days and skips done ones", () => {
    const section = (dueDate: string | null, status = "todo") =>
      ({ dueDate, status }) as Pick<CommandCenterSection, "status" | "dueDate">;
    expect(
      countSectionDeadlines(
        [
          section("2026-10-13"),
          section("2026-10-20"),
          section("2026-10-21"),
          section("2026-09-20"),
          section("2026-10-12"),
          section("2026-10-14", "done"),
          section(null),
        ],
        now,
      ),
    ).toEqual({ dueSoon: 2, overdue: 2 });
  });
});

describe("deriveAttention", () => {
  const tomorrow = new Date(now + 86_400_000).toISOString();

  it("hides a snoozed thread until it raises its hand", () => {
    const plan = { interactionMode: "plan", hasActionableProposedPlan: true } as const;
    expect(keys([shell("plan", plan)])).toEqual(["thread:local:plan"]);
    expect(keys([shell("plan", { ...plan, snoozedUntil: tomorrow })])).toEqual([]);
    expect(keys([shell("asks", { snoozedUntil: tomorrow, hasPendingApprovals: true })])).toEqual([
      "thread:local:asks",
    ]);
  });

  it("leaves out working, archived and quiet threads and idle agents", () => {
    const snapshot: CommandCenterSnapshot = {
      ...EMPTY,
      agentProfiles: [
        {
          id: CommandCenterAgentId.make("idle"),
          archivedAt: null,
        } as unknown as CommandCenterSnapshot["agentProfiles"][number],
      ],
    };
    expect(
      keys(
        [
          shell("working", {
            running: true,
            interactionMode: "plan",
            hasActionableProposedPlan: true,
          }),
          shell("archived", { hasPendingUserInput: true, archivedAt: minutesAgo(1) }),
          shell("quiet"),
        ],
        snapshot,
      ),
    ).toEqual([]);
  });

  it("lists threads in return order, then Command Center items newest first", () => {
    const snapshot = {
      ...EMPTY,
      sections: [
        { id: "s1", status: "blocked", updatedAt: minutesAgo(30), dueDate: null },
      ] as unknown as CommandCenterSection[],
      memory: [
        {
          id: "q1",
          kind: "todo",
          done: false,
          text: "Question: who pays?",
          createdAt: minutesAgo(10),
        },
        { id: "t1", kind: "todo", done: false, text: "Ship it", createdAt: minutesAgo(5) },
      ] as unknown as CommandCenterSnapshot["memory"],
      income: [
        { id: "i1", status: "overdue", date: "2026-09-01" },
        { id: "i2", status: "pending", date: "2026-10-01" },
      ] as unknown as CommandCenterSnapshot["income"],
    };
    const items = attention(
      [
        shell("older", { hasPendingApprovals: true, unsettledAt: minutesAgo(120) }),
        shell("newer", { hasPendingUserInput: true, unsettledAt: minutesAgo(2) }),
      ],
      snapshot,
    );
    expect(items.map((item) => item.key)).toEqual([
      "thread:local:newer",
      "thread:local:older",
      "question:q1",
      "blocked:s1",
      "overdue:i1",
    ]);
    expect(items.slice(0, 2).map((item) => item.kind === "thread" && item.reason)).toEqual([
      "input",
      "approval",
    ]);
  });

  it("lists waiting workflow runs of any project after threads, newest change first", () => {
    const run = (id: string, status: string, updatedAt: string) =>
      ({ id, status, updatedAt }) as unknown as CommandCenterWorkflowRun;
    const snapshot = {
      ...EMPTY,
      income: [{ id: "i1", status: "overdue", date: "2026-09-01" }],
    } as unknown as CommandCenterSnapshot;
    expect(
      deriveAttention({
        shells: [shell("asks", { hasPendingUserInput: true })],
        snapshot,
        environments: [],
        primaryEnvironmentId: local,
        now,
        runs: [
          run("old", "waiting", minutesAgo(30)),
          run("running", "running", minutesAgo(1)),
          run("done", "succeeded", minutesAgo(1)),
          run("new", "waiting", minutesAgo(2)),
        ],
      }).map((item) => item.key),
    ).toEqual(["thread:local:asks", "run:new", "run:old", "overdue:i1"]);
  });
});

describe("deriveWorkingThreads", () => {
  it("counts top-level threads with a run in progress that do not need the user", () => {
    const working = deriveWorkingThreads([
      shell("running", { running: true }),
      shell("child", { running: true, subagent: true }),
      shell("asks", { running: true, hasPendingApprovals: true }),
      shell("archived", { running: true, archivedAt: minutesAgo(1) }),
      shell("idle"),
    ]);
    expect(working.map((thread) => thread.id)).toEqual(["running"]);
  });
});

describe("commandCenterAlerts", () => {
  const working = (updatedAt: string) =>
    ({
      status: "working",
      assignment: null,
      shell: { updatedAt, runtime: { updatedAt } },
    }) as unknown as CommandCenterAgentState;
  const section = (patch: Partial<CommandCenterSection>) =>
    ({
      status: "in_progress",
      tasksDone: 0,
      tasksTotal: 10,
      dueDate: null,
      ...patch,
    }) as unknown as CommandCenterSection;

  it("flags offline hosts, silent working agents and at-risk deliveries only", () => {
    const alerts = commandCenterAlerts({
      environments: [
        { environmentId: "vps", label: "VPS", connected: false },
        { environmentId: "spare", label: "Spare", connected: false },
        { environmentId: "local", label: "Local", connected: true },
      ],
      hostEnvironmentIds: new Set(["vps", "local"]),
      agents: [
        {
          agentId: CommandCenterAgentId.make("quiet"),
          state: working(minutesAgo(STUCK_AFTER_MINUTES)),
        },
        { agentId: CommandCenterAgentId.make("busy"), state: working(minutesAgo(5)) },
      ],
      sections: [
        section({ name: "risky", dueDate: "2026-10-15", tasksDone: 6 }),
        section({ name: "fine", dueDate: "2026-10-15", tasksDone: 7 }),
        section({ name: "later", dueDate: "2026-10-16", tasksDone: 0 }),
        section({ name: "review", dueDate: "2026-10-14", status: "review" }),
      ],
      now,
    });
    expect(
      alerts.map((alert) =>
        alert.kind === "offline"
          ? alert.label
          : alert.kind === "stuck"
            ? alert.agentId
            : alert.section.name,
      ),
    ).toEqual(["VPS", "quiet", "risky"]);
  });
});
