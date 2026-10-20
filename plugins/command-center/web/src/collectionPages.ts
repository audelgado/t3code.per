export function needsCollectionPage(count: number, hasMore: boolean, page: number, size: number) {
  return hasMore && count < page * size;
}

/** Cursor recovery is bounded even when a server repeats a page or claims more after an empty response. */
export async function collectCollectionPages<T extends { id: string }>(
  initial: T[],
  first: { items: T[]; hasMore: boolean },
  target: () => number,
  next: (last: T) => Promise<{ items: T[]; hasMore: boolean }>,
  active: () => boolean,
) {
  const items = [...initial];
  const seen = new Set(items.map((item) => item.id));
  let page = first;
  for (let requests = 0; ; requests++) {
    const added = page.items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    items.push(...added);
    if (!added.length) return { items, hasMore: false };
    if (!page.hasMore || items.length >= target() || requests >= 99 || !active()) return { items, hasMore: page.hasMore };
    page = await next(items.at(-1)!);
  }
}
