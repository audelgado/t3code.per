/** Search titles, identifiers and descriptions, then keep a stable alphabetical directory. */
export function searchLibrary<T>(
  rows: ReadonlyArray<T>,
  query: string,
  fields: (row: T) => ReadonlyArray<string | null>,
) {
  const needle = query.trim().toLocaleLowerCase();
  return rows
    .filter((row) => fields(row).some((field) => field?.toLocaleLowerCase().includes(needle)))
    .toSorted((left, right) => (fields(left)[0] ?? "").localeCompare(fields(right)[0] ?? ""));
}
