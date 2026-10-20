import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { collectionHash, readCollectionState } from "./collectionState.ts";

/** History updates keep the route and mounted form intact; hashchange also updates the app overlay return address. */
export function useCollectionState<T>(key: string, fallback: T, accept?: (value: T) => boolean) {
  const initial = useRef(fallback).current;
  const validator = useRef(accept);
  validator.current = accept;
  const read = useCallback(() => readCollectionState(location.hash, key, initial, validator.current), [key, initial]);
  const [value, setValue] = useState(read);
  useEffect(() => {
    const sync = () => { if (!location.hash.startsWith("#item=") && !location.hash.startsWith("#ask")) setValue(read()); };
    sync();
    addEventListener("hashchange", sync);
    addEventListener("popstate", sync);
    return () => { removeEventListener("hashchange", sync); removeEventListener("popstate", sync); };
  }, [read]);
  const set = useCallback((action: SetStateAction<T>, replace = false) => {
    if (location.hash.startsWith("#item=") || location.hash.startsWith("#ask")) return;
    const current = read();
    const next = typeof action === "function" ? (action as (prev: T) => T)(current) : action;
    const hash = collectionHash(location.hash, key, next, initial);
    if (hash !== location.hash) {
      if (replace) history.replaceState(history.state, "", hash);
      else history.pushState(history.state, "", hash);
      dispatchEvent(new Event("hashchange"));
    }
    setValue(next);
  }, [key, initial, read]);
  return [value, set] as const;
}

/** Session-only drafts survive navigation/reload. Storage failures leave the form usable. */
export function useCollectionDraft<T>(key: string, initial: T) {
  const storageKey = `cc.draft.${key}`;
  const read = () => {
    try { const saved = sessionStorage.getItem(storageKey); return saved === null ? initial : JSON.parse(saved) as T; }
    catch { return initial; }
  };
  const [value, setValue] = useState<T>(read);
  const current = useRef(value);
  useEffect(() => { const next = read(); current.current = next; setValue(next); }, [storageKey]);
  const set = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? (action as (prev: T) => T)(current.current) : action;
    current.current = next;
    setValue(next);
    try { if (next === null) sessionStorage.removeItem(storageKey); else sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
  }, [storageKey]);
  return [value, set] as const;
}

export function clearCollectionDraft(key: string) {
  try { sessionStorage.removeItem(`cc.draft.${key}`); } catch { /* Storage can be unavailable. */ }
}
