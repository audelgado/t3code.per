/** Unknown totals stay indeterminate; inconsistent counts never exceed the scale. */
export function sectionProgress(done: number, total: number) {
  const max = Number.isFinite(total) && total > 0 ? total : undefined;
  const now = max === undefined ? undefined : Math.min(max, Math.max(0, Number.isFinite(done) ? done : 0));
  return { max, now, percent: max === undefined || now === undefined ? 0 : now / max * 100 };
}
