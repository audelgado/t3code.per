/** Page only a loaded collection. Totals describe that collection, not unloaded server rows. */
export function paginateCollection<T>(items: readonly T[], page: number, pageSize: number) {
  const size = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 1;
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(
    pageCount,
    Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1),
  );
  const offset = (currentPage - 1) * size;
  return {
    items: items.slice(offset, offset + size),
    page: currentPage,
    pageCount,
    total,
    start: total === 0 ? 0 : offset + 1,
    end: Math.min(offset + size, total),
  };
}

/** "Load older" fetches rows past the loaded ones, so it belongs after the last loaded page. */
export function showLoadOlder(paged: { page: number; pageCount: number }, hasMore: boolean) {
  return hasMore && paged.page === paged.pageCount;
}

/** Pages `rows`, keeping the row keyed `keptKey` (such as one being answered) on every page. */
export function paginateKeepingRow<T>(
  rows: ReadonlyArray<T>,
  page: number,
  pageSize: number,
  keptKey: string | null,
  keyOf: (row: T) => string,
) {
  const directory = paginateCollection(rows, page, pageSize);
  const kept = keptKey === null ? undefined : rows.find((row) => keyOf(row) === keptKey);
  return {
    ...directory,
    items:
      kept !== undefined && !directory.items.some((row) => keyOf(row) === keptKey)
        ? [...directory.items, kept]
        : directory.items,
  };
}
