import assert from "node:assert/strict";
import test from "node:test";
import type { MachineProjects } from "../../server/types.ts";
import { askDestination } from "./askDestination.ts";

const groups: MachineProjects[] = [
  { machineId: "pc", machineLabel: "PC", status: "online", projects: [{ machineId: "pc", id: "app", title: "App", workspaceRoot: "D:/app", defaultModel: null, updatedAt: "" }] },
  { machineId: "vps", machineLabel: "VPS Tayna", status: "online", projects: [{ machineId: "vps", id: "app", title: "App", workspaceRoot: "/srv/app", defaultModel: null, updatedAt: "" }] },
  { machineId: "empty", machineLabel: "Hermes", status: "online", projects: [] },
];

test("switching systems cannot retain a project from the PC, even with matching project ids", () => {
  assert.deepEqual(askDestination(groups, "vps", "pc:app"), { machineId: "vps", key: "vps:app" });
  assert.deepEqual(askDestination(groups, "empty", "pc:app"), { machineId: "empty", key: "" });
});
test("project links preselect their machine; empty and offline destinations stay explicit", () => {
  assert.deepEqual(askDestination(groups, "", "vps:app"), { machineId: "vps", key: "vps:app" });
  assert.equal(askDestination(groups.map((g) => ({ ...g, status: "offline" })), "vps", "").key, "vps:app");
  assert.deepEqual(askDestination([], "", ""), { machineId: "", key: "" });
});
