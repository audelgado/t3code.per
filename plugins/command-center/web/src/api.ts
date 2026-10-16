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
  /** null until the first answer; false = not paired (401). */
  authed: boolean | null;
}
let live: Live = { view: null, authed: null };
const subs = new Set<() => void>();
const set = (p: Partial<Live>) => {
  live = { ...live, ...p };
  subs.forEach((f) => f());
};

/** Typed fetch. A 401 anywhere flips the app to the Pair screen. */
export async function call<R extends ApiRoute>(
  route: R,
  opts: { params?: Record<string, string>; query?: Record<string, string>; body?: Api[R]["body"] } = {},
): Promise<Api[R]["res"]> {
  const [method, path] = route.split(" ") as [string, string];
  const qs = opts.query && new URLSearchParams(opts.query).toString();
  const url = path.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent(opts.params?.[k] ?? "")) + (qs ? `?${qs}` : "");
  const res = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: opts.body === undefined ? undefined : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401) set({ authed: false, view: null });
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiFail(res.status, e?.error.message ?? `No se pudo completar la solicitud (${res.status})`);
  }
  return (await res.json()) as Api[R]["res"];
}

let es: EventSource | null = null;

/** Load the view, then follow /api/events. Safe to call again after pairing. */
export function connect() {
  es?.close();
  call("GET /api/view")
    .then((view) => {
      set({ view, authed: true });
      es = new EventSource("/api/events");
      es.onmessage = (e) => set({ view: JSON.parse(e.data) as HomeView });
      // A closed source means the server refused it (e.g. session expired): start over.
      es.onerror = () => es?.readyState === EventSource.CLOSED && connect();
    })
    .catch((e) => {
      if (!(e instanceof ApiFail && e.status === 401)) setTimeout(connect, 5000);
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
    () => live,
  );

// Hash routes are parsed in navigation.ts.
export const useHash = () =>
  useSyncExternalStore(
    (f) => (addEventListener("hashchange", f), () => removeEventListener("hashchange", f)),
    () => location.hash,
  );
