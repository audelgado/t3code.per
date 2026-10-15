import type {
  CommandCenterAgentProfile,
  CommandCenterTeam,
  CommandCenterTeamId,
  EnvironmentId,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  checkAgentProvider,
  activeAssignmentsByMachine,
  resolveAutoMachine,
  guessTeamForStep,
  resolveStepMachine,
  splitRequestIntoSteps,
} from "./planLogic";

describe("resolveAutoMachine", () => {
  const primary = "pc" as EnvironmentId;
  const vps = "vps" as EnvironmentId;
  const candidate = (environmentId: EnvironmentId, patch = {}) => ({
    environmentId,
    connected: true,
    hasProject: true,
    providerOk: true,
    activeAssignments: 0,
    ...patch,
  });
  const resolve = (
    candidates: Parameters<typeof resolveAutoMachine>[0]["candidates"],
    explicit: EnvironmentId | "auto" = "auto",
    teamMachine: EnvironmentId | null = null,
  ) => resolveAutoMachine({ candidates, explicit, teamMachine, primary });

  it("honors explicit routes without silently falling back", () => {
    expect(resolve([candidate(primary), candidate(vps)], vps)).toEqual({
      environmentId: vps,
      reason: "explicit",
    });
    expect(resolve([candidate(primary), candidate(vps, { connected: false })], vps)).toHaveProperty(
      "error",
      "The selected machine is offline.",
    );
    expect(
      resolve([candidate(primary), candidate(vps, { hasProject: false })], vps),
    ).toHaveProperty("error");
    expect(
      resolve([candidate(primary), candidate(vps, { providerOk: false })], vps),
    ).toHaveProperty("error");
  });
  it("filters disconnected machines, missing projects and unavailable providers before team preference", () => {
    for (const patch of [{ connected: false }, { hasProject: false }, { providerOk: false }]) {
      expect(resolve([candidate(primary), candidate(vps, patch)], "auto", vps)).toEqual({
        environmentId: primary,
        reason: "only",
      });
    }
    expect(
      resolve([candidate(primary), candidate(vps, { activeAssignments: 4 })], "auto", vps),
    ).toEqual({ environmentId: vps, reason: "team" });
  });
  it("uses the least busy machine and prefers the primary on a tie", () => {
    expect(resolve([candidate(primary, { activeAssignments: 2 }), candidate(vps)])).toEqual({
      environmentId: vps,
      reason: "least-busy",
    });
    expect(resolve([candidate(vps), candidate(primary)])).toEqual({
      environmentId: primary,
      reason: "least-busy",
    });
  });
  it("explains empty candidate sets", () => {
    expect(resolve([])).toHaveProperty("error", "No machines are connected.");
    expect(resolve([candidate(primary, { hasProject: false })])).toHaveProperty(
      "error",
      "This project has no associated copy on a connected machine.",
    );
    expect(resolve([candidate(primary, { providerOk: false })])).toHaveProperty(
      "error",
      "The agent's provider is not available on a connected machine with this project.",
    );
  });
  it("counts only unfinished working assignments", () => {
    expect(
      activeAssignmentsByMachine([
        { status: "working", assignment: { environmentId: vps, finishedAt: null } },
        { status: "working", assignment: { environmentId: vps, finishedAt: null } },
        { status: "idle", assignment: { environmentId: primary, finishedAt: null } },
        {
          status: "working",
          assignment: { environmentId: primary, finishedAt: "2026-10-14T00:00:00Z" },
        },
        { status: "working", assignment: null },
      ]),
    ).toEqual(new Map([[vps, 2]]));
  });
});

describe("splitRequestIntoSteps", () => {
  it("splits on punctuation and English or Spanish connectives", () => {
    expect(splitRequestIntoSteps("Fix the login page, add tests and update docs")).toEqual([
      "Fix the login page",
      "add tests",
      "update docs",
    ]);
    expect(splitRequestIntoSteps("Armar la API y conectar el front; revisar")).toEqual([
      "Armar la API",
      "conectar el front",
      "revisar",
    ]);
  });

  it("keeps ordered work in one step, since steps start together", () => {
    expect(splitRequestIntoSteps("Write the migration and then run it, update docs")).toEqual([
      "Write the migration and then run it",
      "update docs",
    ]);
    expect(splitRequestIntoSteps("Armar la API y luego conectar el front")).toEqual([
      "Armar la API y luego conectar el front",
    ]);
  });

  it("keeps words that only contain a connective", () => {
    expect(splitRequestIntoSteps("Update the android brand theme")).toEqual([
      "Update the android brand theme",
    ]);
    expect(splitRequestIntoSteps("  ,  and ")).toEqual([]);
  });
});

describe("guessTeamForStep", () => {
  const team = (id: string, name: string) =>
    ({ id: id as CommandCenterTeamId, name, archivedAt: null }) as CommandCenterTeam;
  const teams = [team("front", "Frontend"), team("back", "Backend API")];
  const agents = [
    { teamId: "front", role: "React and CSS designer", archivedAt: null },
  ] as unknown as CommandCenterAgentProfile[];

  it("matches team names and member roles, or returns null", () => {
    expect(guessTeamForStep("Expose a new API endpoint", teams, agents)).toBe("back");
    expect(guessTeamForStep("Polish the CSS of the header", teams, agents)).toBe("front");
    expect(guessTeamForStep("Call the accountant", teams, agents)).toBeNull();
  });

  it("ignores filler words and never guesses the Onboarding team", () => {
    const withOnboarding = [
      team("cc-team:onboarding", "Onboarding scout and organizer"),
      team("ops", "The ops crew"),
    ];
    expect(guessTeamForStep("Fix the build", withOnboarding, [])).toBeNull();
    expect(guessTeamForStep("Onboarding docs for the scout", withOnboarding, [])).toBeNull();
  });
});

describe("resolveStepMachine", () => {
  const primary = "env-primary" as EnvironmentId;
  const vps = "env-vps" as EnvironmentId;
  it("uses an explicit pick, else the team machine, else the primary", () => {
    expect(resolveStepMachine(vps, { environmentId: null }, primary)).toBe(vps);
    expect(resolveStepMachine("auto", { environmentId: vps }, primary)).toBe(vps);
    expect(resolveStepMachine("auto", { environmentId: null }, primary)).toBe(primary);
    expect(resolveStepMachine("auto", undefined, primary)).toBe(primary);
  });
});

describe("checkAgentProvider", () => {
  const selection = { instanceId: "codex", model: "gpt-5" } as ModelSelection;
  const provider = (patch: Partial<ServerProvider>) =>
    ({
      instanceId: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      models: [{ slug: "gpt-5" }],
      ...patch,
    }) as unknown as ServerProvider;

  it("passes when the provider runs the model, or the list has not loaded", () => {
    expect(checkAgentProvider(selection, [provider({})], "VPS")).toBeNull();
    expect(checkAgentProvider(selection, null, "VPS")).toBeNull();
  });

  it("errors when the provider is missing, off or unavailable", () => {
    expect(checkAgentProvider(selection, [], "VPS")?.level).toBe("error");
    expect(checkAgentProvider(selection, [provider({ enabled: false })], "VPS")?.level).toBe(
      "error",
    );
    expect(
      checkAgentProvider(selection, [provider({ availability: "unavailable" })], "VPS")?.level,
    ).toBe("error");
    expect(checkAgentProvider(selection, [provider({ installed: false })], "VPS")?.message).toBe(
      "Codex is not available on VPS.",
    );
  });

  it("only warns about a model the provider does not list", () => {
    const issue = checkAgentProvider(
      { ...selection, model: "custom-model" },
      [provider({})],
      "VPS",
    );
    expect(issue?.level).toBe("warning");
  });
});
