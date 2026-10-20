/** Collection state stays in the hash query without changing the route or other owners' parameters. */
export function collectionHash(hash: string, key: string, value: unknown, fallback: unknown) {
  const at = hash.indexOf("?");
  const path = at < 0 ? hash : hash.slice(0, at);
  const query = new URLSearchParams(at < 0 ? "" : hash.slice(at + 1));
  if (JSON.stringify(value) === JSON.stringify(fallback)) query.delete(key);
  else query.set(key, JSON.stringify(value));
  return path + (query.size ? `?${query}` : "");
}

export function readCollectionState<T>(hash: string, key: string, fallback: T, accept?: (value: T) => boolean): T {
  try {
    const at = hash.indexOf("?");
    const raw = at < 0 ? null : new URLSearchParams(hash.slice(at + 1)).get(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    if (!matchesShape(value, fallback) || (accept && !accept(value as T))) return fallback;
    return value as T;
  } catch { return fallback; }
}

function matchesShape(value: unknown, fallback: unknown): boolean {
  if (fallback === null) return value === null || typeof value === "string";
  if (typeof fallback === "number") return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (typeof fallback === "string") return typeof value === "string" && value.length <= 2000;
  if (typeof fallback === "boolean") return typeof value === "boolean";
  if (typeof fallback === "object" && fallback && typeof value === "object" && value && !Array.isArray(value)) {
    return Object.entries(fallback).every(([key, initial]) => matchesShape((value as Record<string, unknown>)[key], initial));
  }
  return false;
}
