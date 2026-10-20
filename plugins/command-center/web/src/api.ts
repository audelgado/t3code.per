import { useSyncExternalStore } from "react";
import type { Api, ApiError, ApiRoute, HomeView } from "../../server/types.ts";

export class ApiFail extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Live {
  view: HomeView | null;
  connection: "connecting" | "connected" | "retrying";
  connectionError: string | null;
  /** null until the first answer; false = not paired (401). */
  authed: boolean | null;
}
let live: Live = { view: null, authed: null, connection: "connecting", connectionError: null };
const subs = new Set<() => void>();
const set = (p: Partial<Live>) => {
  live = { ...live, ...p };
  subs.forEach((f) => f());
};

/** Typed fetch. A 401 anywhere flips the app to the Pair screen. */
export async function call<R extends ApiRoute>(
  route: R,
  opts: { params?: Record<string, string>; query?: Record<string, string>; body?: Api[R]["body"]; signal?: AbortSignal } = {},
): Promise<Api[R]["res"]> {
  const [method, path] = route.split(" ") as [string, string];
  const qs = opts.query && new URLSearchParams(opts.query).toString();
  const url = path.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(opts.params?.[k] ?? "")) + (qs ? `?${qs}` : "");
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    signal: opts.signal,
    headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  opts.signal?.throwIfAborted();
  if (res.status === 401) set({ authed: false, view: null });
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiFail(res.status, e?.error.message ?? `No se pudo completar la solicitud (${res.status})`);
  }
  return (await res.json()) as Api[R]["res"];
}

let es: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let pendingView: AbortController | undefined;

/** Load the view, then follow /api/events. Safe to call again after pairing. */
export function connect() {
  const current = ++generation;
  clearTimeout(retry);
  pendingView?.abort();
  pendingView = new AbortController();
  es?.close();
  es = null;
  set({ connection: "connecting", connectionError: null });
  return call("GET /api/view", { signal: pendingView.signal })
    .then((view) => {
      if (current !== generation) return;
      set({ view, authed: true });
      const source = new EventSource("/api/events");
      es = source;
      source.onopen = () => current === generation && set({ connection: "connected", connectionError: null });
      source.onmessage = (e) => {
        if (current !== generation) return;
        try { set({ view: JSON.parse(e.data) as HomeView, connection: "connected", connectionError: null }); }
        catch { set({ connection: "retrying", connectionError: "No se pudo leer la actualización del servidor." }); }
      };
      // A closed source means the server refused it (e.g. session expired): start over.
      source.onerror = () => {
        if (current !== generation) return;
        set({ connection: "retrying", connectionError: "Se perdió la conexión. Los datos pueden estar desactualizados." });
        if (source.readyState === EventSource.CLOSED) retry = setTimeout(connect, 5000);
      };
    })
    .catch((e) => {
      if (current !== generation || e instanceof ApiFail && e.status === 401) return;
      set({ connection: "retrying", connectionError: e instanceof Error ? e.message : "No se pudo conectar al servidor." });
      retry = setTimeout(connect, 5000);
    });
}

/** Pull the view right after a mutation instead of waiting for the next SSE frame. */
export const refresh = () =>
  call("GET /api/view")
    .then((view) => set({ view }))
    .catch(() => {});

export const useLive = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    getLiveSnapshot,
  );

export const getLiveSnapshot = () => live;

// Hash routes are parsed in navigation.ts.
export const useHash = () =>
  useSyncExternalStore(
    (f) => (addEventListener("hashchange", f), () => removeEventListener("hashchange", f)),
    () => location.hash,
  );
