export type ProjectSort = "activity" | "name" | "attention" | "manual";

export const PROJECT_SORT_KEY = "t3code:command-center:project-sort";
export const WORK_SORT_KEY = "t3code:command-center:work:sort";
export const WORK_COLLAPSED_KEY = "t3code:command-center:work:collapsed";
export const WORK_DENSITY_KEY = "t3code:command-center:work:density";

/** Unknown projects retain their input order after the explicitly ordered ones. */
export function compareManual(order: ReadonlyArray<string>) {
  const positions = new Map<string, number>();
  for (const [index, key] of order.entries()) {
    if (!positions.has(key)) positions.set(key, index);
  }
  return (left: string, right: string) =>
    (positions.get(left) ?? order.length) - (positions.get(right) ?? order.length);
}

/** Move visible neighbors while keeping the saved positions of projects hidden by filters. */
export function moveProject(
  order: ReadonlyArray<string>,
  listedKeys: ReadonlyArray<string>,
  key: string,
  direction: -1 | 1,
) {
  const present = new Set(listedKeys);
  const result = [...new Set([...order, ...listedKeys])];
  const visible = result.filter((entry) => present.has(entry));
  const visibleIndex = visible.indexOf(key);
  const neighbor = visible[visibleIndex + direction];
  const index = result.indexOf(key);
  if (visibleIndex >= 0 && neighbor !== undefined) {
    const destination = result.indexOf(neighbor);
    result[destination] = key;
    result[index] = neighbor;
  }
  return result.slice(0, 200);
}
