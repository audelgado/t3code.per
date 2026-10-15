import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import { compareManual, type ProjectSort } from "../projectOrder";
import { paginateCollection } from "../collectionPaging";
import type { WorkItem } from "./workItems";

export interface WorkLane {
  readonly key: string;
  readonly project: WorkItem["project"];
  readonly items: readonly WorkItem[];
}
export const filterByMachine = (items: readonly WorkItem[], machine: EnvironmentId | "all") =>
  items.filter((item) => machine === "all" || item.environmentId === machine);
export function orderLanes(
  items: readonly WorkItem[],
  sort: ProjectSort,
  manual: readonly string[],
): WorkLane[] {
  const lanes = new Map<string, WorkLane>();
  for (const item of items) {
    const lane = lanes.get(item.projectKey);
    lanes.set(item.projectKey, {
      key: item.projectKey,
      project: item.project,
      items: [...(lane?.items ?? []), item],
    });
  }
  const activity = (lane: WorkLane) =>
    lane.items.reduce((latest, item) => (item.updatedAt > latest ? item.updatedAt : latest), "");
  const attention = (lane: WorkLane) =>
    lane.items.filter((item) => item.agent === "needs-you").length;
  return [...lanes.values()].sort((a, b) =>
    sort === "manual"
      ? compareManual(manual)(a.key, b.key)
      : sort === "name"
        ? a.project.title.localeCompare(b.project.title)
        : sort === "attention"
          ? attention(b) - attention(a) || activity(b).localeCompare(activity(a))
          : activity(b).localeCompare(activity(a)),
  );
}
export const nextIndex = (index: number, count: number) => (count > 0 ? (index + 1) % count : 0);
export const prevIndex = (index: number, count: number) =>
  count > 0 ? (index - 1 + count) % count : 0;
export const pageLanes = (lanes: readonly WorkLane[], page: number) =>
  paginateCollection(lanes, page, 4);
export const statusKey = (item: Pick<WorkItem, "environmentId" | "cwd">) =>
  JSON.stringify([item.environmentId, item.cwd]);
/** Focus wins, then a requested visible row, then expanded page rows by activity. */
export function chooseStatusItems(
  focused: WorkItem | undefined,
  lanes: readonly WorkLane[],
  collapsed: readonly string[],
  requested: WorkItem | undefined,
) {
  const candidates = [
    focused,
    requested,
    ...lanes
      .filter((lane) => !collapsed.includes(lane.key))
      .flatMap((lane) => lane.items)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  ];
  const picked = new Map<string, WorkItem>();
  for (const item of candidates)
    if (item && !picked.has(statusKey(item)) && picked.size < 20) picked.set(statusKey(item), item);
  return [...picked.values()];
}
export function isWorkTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.matches("input,textarea,select") ||
      target.isContentEditable ||
      target.closest('[role="dialog"], [aria-modal="true"], [data-slot$="popup"]') !== null)
  );
}

/** A checkout may have been switched externally; its status belongs only to the observed branch. */
export function usableWorkStatus(
  item: WorkItem,
  status: VcsStatusResult | null,
): VcsStatusResult | null {
  return status?.isRepo && status.refName === item.branch ? status : null;
}
