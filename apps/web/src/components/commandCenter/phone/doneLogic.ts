// @effect-diagnostics globalDate:off -- Calendar windows follow the viewer's local timezone.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

/** Stored completion times only; opening Done never starts an agent or reads a transcript. */
export function deriveDoneFeed(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  now: number,
  range: "today" | "week",
) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  const items = shells
    .filter((shell) => {
      if (
        shell.archivedAt !== null ||
        shell.deletedAt !== null ||
        shell.lineage.relationshipToParent === "subagent"
      )
        return false;
      const run = shell.latestRun;
      if (!run?.completedAt || (run.status !== "completed" && run.status !== "failed"))
        return false;
      const at = Date.parse(run.completedAt);
      return at >= start.getTime() && at <= now;
    })
    .toSorted((a, b) => b.latestRun!.completedAt!.localeCompare(a.latestRun!.completedAt!));
  return { items, total: items.length };
}
