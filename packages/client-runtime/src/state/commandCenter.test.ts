import {
  CommandCenterMemoryId,
  type CommandCenterMemoryEntry,
  type CommandCenterSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { applyCommandCenterEvent } from "./commandCenter.ts";

const EMPTY: CommandCenterSnapshot = {
  agentProfiles: [],
  teams: [],
  assignments: [],
  sections: [],
  memory: [],
  income: [],
  costs: [],
};

const memory = (id: string, text: string): CommandCenterMemoryEntry => ({
  id: CommandCenterMemoryId.make(id),
  projectId: null,
  sectionId: null,
  threadId: null,
  kind: "note",
  text,
  done: false,
  source: "user",
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
});

describe("applyCommandCenterEvent", () => {
  it("ignores changes until the first snapshot", () => {
    expect(
      applyCommandCenterEvent(null, {
        type: "upserted",
        record: { entity: "memory", value: memory("a", "one") },
      }),
    ).toBeNull();
  });

  it("appends new rows, replaces existing ones in place, and removes deleted ones", () => {
    // Hermes has no Array.prototype.with; the fold must not need it.
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "with");
    Reflect.deleteProperty(Array.prototype, "with");
    onTestFinished(() => {
      if (descriptor) Reflect.defineProperty(Array.prototype, "with", descriptor);
    });
    let state = applyCommandCenterEvent(null, {
      type: "snapshot",
      snapshot: { ...EMPTY, memory: [memory("a", "one"), memory("b", "two")] },
    });
    state = applyCommandCenterEvent(state, {
      type: "upserted",
      record: { entity: "memory", value: memory("c", "three") },
    });
    state = applyCommandCenterEvent(state, {
      type: "upserted",
      record: { entity: "memory", value: memory("a", "one, edited") },
    });
    state = applyCommandCenterEvent(state, { type: "deleted", entity: "memory", id: "b" });
    expect(state?.memory.map((entry) => [entry.id, entry.text])).toEqual([
      ["a", "one, edited"],
      ["c", "three"],
    ]);
  });

  it("starts over from a fresh snapshot", () => {
    const stale = applyCommandCenterEvent(null, {
      type: "snapshot",
      snapshot: { ...EMPTY, memory: [memory("a", "one")] },
    });
    expect(applyCommandCenterEvent(stale, { type: "snapshot", snapshot: EMPTY })).toEqual(EMPTY);
  });
});
