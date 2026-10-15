import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import {
  chooseStatusItems,
  filterByMachine,
  nextIndex,
  orderLanes,
  pageLanes,
  prevIndex,
  statusKey,
  usableWorkStatus,
} from "./workView";
import { testItem } from "./workTestFixtures";
describe("Work view", () => {
  it("keeps independent machines and projects", () => {
    const a = testItem();
    const b = testItem(1, { environmentId: EnvironmentId.make("vps") });
    expect(filterByMachine([a, b], a.environmentId)).toEqual([a]);
    expect(filterByMachine([a, b], "all")).toHaveLength(2);
  });
  it("sorts by activity, name, attention and manual including unknown keys", () => {
    const a = testItem(0, { updatedAt: "2026-10-10" });
    const b = testItem(1, { agent: "needs-you", updatedAt: "2026-10-02" });
    const c = testItem(2, { updatedAt: "2026-10-14" });
    const list = [a, b, c];
    expect(orderLanes(list, "activity", []).map((l) => l.key)).toEqual([
      c.projectKey,
      a.projectKey,
      b.projectKey,
    ]);
    expect(orderLanes(list, "name", []).map((l) => l.key)).toEqual([
      a.projectKey,
      b.projectKey,
      c.projectKey,
    ]);
    expect(orderLanes(list, "attention", [])[0]?.key).toBe(b.projectKey);
    expect(orderLanes(list, "manual", [b.projectKey]).map((l) => l.key)).toEqual([
      b.projectKey,
      a.projectKey,
      c.projectKey,
    ]);
  });
  it("rotates with wraparound including empty collections", () => {
    expect(nextIndex(2, 3)).toBe(0);
    expect(prevIndex(0, 3)).toBe(2);
    expect(nextIndex(0, 0)).toBe(0);
    expect(prevIndex(0, 0)).toBe(0);
  });
  it("pages four projects and clamps after deletion", () => {
    const lanes = orderLanes(
      Array.from({ length: 9 }, (_, i) => testItem(i)),
      "name",
      [],
    );
    expect(pageLanes(lanes, 1).items).toHaveLength(4);
    expect(pageLanes(lanes, 3).items).toHaveLength(1);
    expect(pageLanes(lanes, 100).page).toBe(3);
  });
  it("caps unique checkouts at twenty, with focus and requested row first", () => {
    const items = Array.from({ length: 30 }, (_, i) => testItem(i));
    const lanes = orderLanes(items, "activity", []);
    const chosen = chooseStatusItems(items[29], lanes, [items[27]!.projectKey], items[28]);
    expect(chosen).toHaveLength(20);
    expect(chosen[0]).toBe(items[29]);
    expect(chosen[1]).toBe(items[28]);
    expect(chosen.some((item) => item === items[27])).toBe(false);
    expect(new Set(chosen.map(statusKey)).size).toBe(20);
    expect(
      chooseStatusItems(
        items[0],
        lanes,
        lanes.map((l) => l.key),
        items[0],
      ),
    ).toEqual([items[0]]);
  });
});

it("never gives one branch another branch checkout status", () => {
  const item = testItem();
  const status: VcsStatusResult = {
    isRepo: true,
    isDefaultRef: false,
    hasPrimaryRemote: true,
    refName: "other",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 2,
    behindCount: 1,
    pr: null,
  };
  expect(usableWorkStatus(item, status)).toBeNull();
  expect(usableWorkStatus(item, { ...status, refName: item.branch })).not.toBeNull();
});
