import { useCollectionState } from "./collectionHooks.ts";
import { collectionHash as stateHash } from "./collectionState.ts";

/** Change one collection filter without discarding routing or another screen's state. */
export function collectionHash(hash: string, key: string, value: string, fallback = "") {
  return stateHash(hash, key, value, fallback);
}

export function useCollectionQuery(key: string, fallback = ""): [string, (value: string) => void] {
  const [value, setValue] = useCollectionState(key, fallback);
  return [value, setValue];
}

export function useCollectionPage(key: string): [number, (page: number) => void] {
  const [page, setPage] = useCollectionState(key, 1);
  return [page, setPage];
}

/** Run details retain the library's filters so returning to the list restores them. */
export function workflowListHash(target: string, source: string) {
  const params = new URLSearchParams(source.split("?")[1] ?? "");
  const [path, query = ""] = target.split("?");
  const result = new URLSearchParams(query);
  for (const key of ["flowQuery", "flowLibraryPage", "flowRunsPage"]) {
    const value = params.get(key);
    if (value !== null) result.set(key, value);
  }
  return path + (result.size ? `?${result}` : "");
}
