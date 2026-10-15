import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";
import { deriveDoneFeed } from "./doneLogic";

describe("phone done feed", () => {
  const now = new Date(2026, 9, 14, 12).getTime();
  const shell = (hour: number, patch: Partial<EnvironmentThreadShell> = {}) =>
    ({
      archivedAt: null,
      deletedAt: null,
      lineage: { relationshipToParent: null },
      latestRun: { completedAt: new Date(2026, 9, 14, hour).toISOString(), status: "completed" },
      ...patch,
    }) as EnvironmentThreadShell;
  it("uses local midnight and includes only finished root threads newest first", () => {
    const older = shell(0),
      newer = shell(10);
    const feed = deriveDoneFeed(
      [
        older,
        shell(-1),
        newer,
        shell(11, { archivedAt: "archived" }),
        shell(11, { deletedAt: "deleted" }),
        shell(13),
      ],
      now,
      "today",
    );
    expect(feed.items).toEqual([newer, older]);
    expect(feed.total).toBe(2);
  });
  it("uses a seven-day calendar window and excludes subagents and unfinished runs", () => {
    const sixDaysAgo = shell(-24 * 6),
      sevenDaysAgo = shell(-24 * 7);
    expect(
      deriveDoneFeed(
        [
          sixDaysAgo,
          sevenDaysAgo,
          shell(1, {
            lineage: { relationshipToParent: "subagent" } as EnvironmentThreadShell["lineage"],
          }),
          shell(2, { latestRun: null }),
        ],
        now,
        "week",
      ).items,
    ).toEqual([sixDaysAgo]);
  });
});
