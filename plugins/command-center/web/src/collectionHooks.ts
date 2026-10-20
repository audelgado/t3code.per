import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { collectionHash, readCollectionState } from "./collectionState.ts";
import { collectionDrafts } from "./collectionDrafts.ts";

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
export function useCollectionDraft<T>(key: string, initial: T, accept?: (value: unknown) => boolean) {
  const [state, setState] = useState(() => ({ key, value: collectionDrafts.read(key, initial, accept) }));
  // Cambiar de proyecto restaura su borrador en el mismo render, antes de aceptar ediciones.
  const value = state.key === key ? state.value : collectionDrafts.read(key, initial, accept);
  const current = useRef(value);
  current.current = value;
  if (state.key !== key) setState({ key, value });
  const set = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === "function" ? (action as (prev: T) => T)(current.current) : action;
    current.current = next;
    setState({ key, value: next });
    collectionDrafts.write(key, next);
  }, [key]);
  return [value, set] as const;
}

export function clearCollectionDraft(key: string) {
  collectionDrafts.clear(key);
}
