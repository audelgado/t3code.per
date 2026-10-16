// Web Push on the page side. enablePush() must run from a tap: iOS grants permission only on a user gesture,
// and only in the home-screen app (Safari tabs have no PushManager).
import type { PushApi } from "../../server/push.ts";

export type PushState = "unsupported" | "denied" | "off" | "on";

async function api<R extends keyof PushApi>(route: R, body?: PushApi[R]["body"]): Promise<PushApi[R]["res"]> {
  const [method, path] = route.split(" ") as [string, string];
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(e?.error?.message ?? `No se pudo completar la solicitud (${res.status})`);
  }
  return (await res.json()) as PushApi[R]["res"];
}

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const current = async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null;
const keyBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const save = (sub: PushSubscription) => {
  const { endpoint, keys } = sub.toJSON();
  return api("POST /api/push/subscribe", { endpoint: endpoint!, keys: { p256dh: keys!.p256dh!, auth: keys!.auth! } });
};

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && (await current()) ? "on" : "off";
}

/** Call from a tap handler. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission(); // first, while the tap still counts as a gesture
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await navigator.serviceWorker.register("/sw.js");
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api("GET /api/push/key");
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await save(sub);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = supported() ? await current() : null;
  if (sub) {
    await api("DELETE /api/push/subscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  return pushState();
}

export const testPush = () => api("POST /api/push/test");

/** Call once per app load: re-posting is an idempotent upsert by endpoint and heals rotated or pruned subscriptions. */
export async function syncPush() {
  if (!supported() || Notification.permission !== "granted") return;
  const sub = await current();
  if (sub) await save(sub).catch(() => {});
}
