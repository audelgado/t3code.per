import type {
  CommandCenterAgentId,
  CommandCenterAgentProfile,
  CommandCenterAssignment,
  CommandCenterMemoryEntry,
  CommandCenterSection,
  CommandCenterTeam,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CommandCenterAgentState } from "../logic";
import { unmetDependencies } from "../projects/logic";
import {
  commandCenterAlerts,
  daysUntil,
  resolveDependencyWires,
  resolveHandoffs,
  STUCK_AFTER_MINUTES,
} from "./teamLogic";

describe("resolveHandoffs", () => {
  it("resolves the sender from the thread and the receiver from the text, newest first", () => {
    const teams = [
      { id: "front", name: "Frontend", archivedAt: null },
      { id: "back", name: "Backend", archivedAt: null },
    ] as unknown as CommandCenterTeam[];
    const agents = [{ id: "a1", teamId: "back" }] as unknown as CommandCenterAgentProfile[];
    const assignments = [{ agentId: "a1", threadId: "t1" }] as unknown as CommandCenterAssignment[];
    const memory = [
      { kind: "handoff", threadId: "t1", text: "API ready for frontend", createdAt: "2026-01-01" },
      { kind: "note", threadId: null, text: "Frontend", createdAt: "2026-01-03" },
      { kind: "handoff", threadId: null, text: "Nobody named", createdAt: "2026-01-02" },
    ] as unknown as CommandCenterMemoryEntry[];

    const handoffs = resolveHandoffs(memory, assignments, agents, teams, 10);
    expect(handoffs.map(({ from, to }) => [from, to])).toEqual([
      [null, null],
      ["back", "front"],
    ]);
  });
});

describe("daysUntil", () => {
  it("counts calendar days from today", () => {
    const now = new Date(2026, 9, 13, 23, 30).getTime();
    expect(daysUntil("2026-10-13", now)).toBe(0);
    expect(daysUntil("2026-10-20", now)).toBe(7);
    expect(daysUntil("2026-10-12", now)).toBe(-1);
  });
});

describe("commandCenterAlerts", () => {
  const now = new Date(2026, 9, 13, 12, 0).getTime();
  const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const working = (updatedAt: string) =>
    ({
      status: "working",
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
          agentId: "quiet" as CommandCenterAgentId,
          state: working(minutesAgo(STUCK_AFTER_MINUTES)),
        },
        { agentId: "busy" as CommandCenterAgentId, state: working(minutesAgo(5)) },
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

describe("resolveDependencyWires", () => {
  it("joins each unmet dependency to the teams that last worked on both sections", () => {
    const sections = [
      { id: "ui", status: "in_progress", dependsOn: ["api"] },
      { id: "api", status: "todo", dependsOn: [] },
    ] as unknown as CommandCenterSection[];
    const agents = [
      { id: "a1", teamId: "front" },
      { id: "a2", teamId: "back" },
    ] as unknown as CommandCenterAgentProfile[];
    const assignments = [
      { agentId: "a2", sectionId: "api", createdAt: "2026-01-01" },
      { agentId: "a1", sectionId: "ui", createdAt: "2026-01-02" },
    ] as unknown as CommandCenterAssignment[];

    const wires = resolveDependencyWires(
      unmetDependencies(sections),
      sections,
      assignments,
      agents,
    );
    expect(
      wires.map(({ section, dependency, from, to }) => [section.id, dependency.id, from, to]),
    ).toEqual([["ui", "api", "front", "back"]]);
  });
});
