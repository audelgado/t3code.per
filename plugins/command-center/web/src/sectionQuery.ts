import { useHash } from "./api.ts";

/** Change one collection filter without discarding routing or another screen's state. */
export function collectionHash(hash: string, key: string, value: string, fallback = "") {
  const [path, query = ""] = hash.split("?");
  const params = new URLSearchParams(query);
  if (value === fallback) params.delete(key); else params.set(key, value);
  const suffix = params.toString();
  return `${path}${suffix ? `?${suffix}` : ""}`;
}

export function useCollectionQuery(key: string, fallback = ""): [string, (value: string) => void] {
  const hash = useHash();
  const params = new URLSearchParams(hash.split("?")[1] ?? "");
  return [params.get(key) ?? fallback, (value) => {
    const next = collectionHash(location.hash, key, value, fallback);
    if (next === location.hash) return;
    history.replaceState(history.state, "", next);
    dispatchEvent(new HashChangeEvent("hashchange"));
  }];
}

export function useCollectionPage(key: string): [number, (page: number) => void] {
  const [value, setValue] = useCollectionQuery(key, "1");
  const page = Number(value);
  return [Number.isSafeInteger(page) && page > 0 ? page : 1, (next) => setValue(String(next))];
}

/** Run details retain the library's filters so returning to the list restores them. */
export function workflowListHash(target: string, source: string) {
  const params = new URLSearchParams(source.split("?")[1] ?? "");
  for (const key of ["flowQuery", "flowLibraryPage", "flowRunsPage"]) {
    const value = params.get(key);
    if (value !== null) target = collectionHash(target, key, value);
  }
  return target;
}
