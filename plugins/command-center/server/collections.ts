/** Page a loaded collection, keeping the current page valid as live items disappear. */
export function paginateCollection<T>(items: readonly T[], page: number, size: number) {
  const pageSize = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 10;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pageCount, Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1));
  const offset = (current - 1) * pageSize;
  return { items: items.slice(offset, offset + pageSize), page: current, pageCount, total, start: total === 0 ? 0 : offset + 1, end: Math.min(offset + pageSize, total) };
}
