import type {
  CommandCenterAgentProfile,
  CommandCenterAssignment,
  CommandCenterMemoryEntry,
  CommandCenterSection,
  CommandCenterTeam,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { CommandCenterAgentId as AgentId, EnvironmentId } from "@t3tools/contracts";

import { unmetDependencies } from "../projects/logic";
import {
  agentMachineKey,
  resolveDependencyWires,
  resolveHandoffs,
  selectTeamMemberPage,
} from "./teamLogic";

describe("team member directory", () => {
  const members = Array.from({ length: 26 }, (_, index) => ({
    id: AgentId.make(`agent-${index}`),
    name: `Agent ${index}`,
    role: index === 24 ? "Release engineer" : "Developer",
  }));
  const taskOf = (agent: (typeof members)[number]) =>
    agent.id === members[25]!.id ? "Verify staging" : null;

  it("keeps the lead pinned and makes every other member reachable once across pages", () => {
    const first = selectTeamMemberPage(members, members[15]!.id, "", 1, taskOf);
    expect(first.lead).toEqual(members[15]);
    expect(first.items).toHaveLength(10);
    expect(first.total).toBe(25);
    const paged = [1, 2, 3].flatMap(
      (page) => selectTeamMemberPage(members, members[15]!.id, "", page, taskOf).items,
    );
    expect(paged).toEqual(members.filter((agent) => agent.id !== members[15]!.id));
  });

  it("finds members beyond the first page by role or task, while retaining the lead", () => {
    const result = selectTeamMemberPage(members, members[0]!.id, " RELEASE ", 3, taskOf);
    expect(result.items).toEqual([members[24]]);
    expect(result.lead).toEqual(members[0]);
    expect(result.page).toBe(1);
    expect(selectTeamMemberPage(members, members[0]!.id, "staging", 1, taskOf).items).toEqual([
      members[25],
    ]);
    expect(selectTeamMemberPage(members, members[0]!.id, "Agent 0", 1, taskOf).items).toEqual([]);
  });

  it("retains the roster when a team name matched instead of a member", () => {
    expect(selectTeamMemberPage(members, null, "Platform team", 1, taskOf).total).toBe(26);
  });
});

describe("agentMachineKey", () => {
  const known = new Set(["local", "vps"]);

  it("places an agent without a team where its latest assignment ran, else on the primary", () => {
    const unassigned = [
      { name: "Last on vps", assignment: { environmentId: EnvironmentId.make("vps") } },
      { name: "Never assigned", assignment: null },
      { name: "Gone machine", assignment: { environmentId: EnvironmentId.make("old") } },
    ];
    const on = (machine: string) =>
      unassigned
        .filter((agent) => agentMachineKey(agent.assignment, "local", known) === machine)
        .map((agent) => agent.name);
    expect(on("vps")).toEqual(["Last on vps"]);
    expect(on("local")).toEqual(["Never assigned"]);
    expect(on("unknown")).toEqual(["Gone machine"]);
  });
});

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
