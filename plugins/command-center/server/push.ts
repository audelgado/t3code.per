// Web Push on node:crypto only: RFC 8291 (aes128gcm) + RFC 8292 (VAPID).
// Pushes cover CC tasks and alerts; every other thread's needs-you is left to T3 Connect.
// The VAPID private key lives in CC_HOME/vapid.json (0600); backups exclude it.
import { chmodSync, existsSync, readFileSync, writeFileSync, type PathLike } from "node:fs";
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type JsonWebKey } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { kvGet, kvSet } from "./db.ts";
import { HttpError, type Route } from "./http.ts";
import type { HomeView, Ok } from "./types.ts";

export const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");
const chmod600 = (path: PathLike) => process.platform !== "win32" && existsSync(path) && chmodSync(path, 0o600);

export interface Vapid {
  privateJwk: JsonWebKey;
  /** Uncompressed P-256 point, base64url: the browser's applicationServerKey. */
  publicKey: string;
}

export interface PushSub {
  endpoint: string;
  /** base64url, from PushSubscription.toJSON().keys. */
  p256dh: string;
  auth: string;
}

/** Payload the service worker reads: title, body, notification tag, CC path to open. */
export interface PushMessage {
  /** Dedupe id: each id is pushed at most once per 24 h. */
  id: string;
  t: string;
  b: string;
  tag: string;
  u: string;
  urgency: "high" | "normal";
}

/** Push routes, shaped like `Api` in types.ts so the wire-up can merge them. */
export interface PushApi {
  "GET /api/push/key": { body: never; res: { key: string } };
  "POST /api/push/subscribe": { body: { endpoint: string; keys: { p256dh: string; auth: string } }; res: Ok };
  "DELETE /api/push/subscribe": { body: { endpoint: string }; res: Ok };
  "POST /api/push/test": { body: never; res: { sent: number } };
}

/** RFC 8291 aes128gcm body for one message. `asPrivate` and `salt` exist for the RFC test vector only. */
export function encryptPayload(plaintext: string, p256dh: string, auth: string, opts: { asPrivate?: string; salt?: Buffer } = {}): Buffer {
  const salt = opts.salt ?? randomBytes(16);
  const ua = unb64u(p256dh);
  const as = createECDH("prime256v1");
  if (opts.asPrivate) as.setPrivateKey(unb64u(opts.asPrivate));
  else as.generateKeys();
  const asPub = as.getPublicKey(); // 65 bytes, uncompressed
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]);
  const ikm = Buffer.from(hkdfSync("sha256", as.computeSecret(ua), unb64u(auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); // salt(16) | rs(4, big endian) | idlen(1)
  salt.copy(head);
  head.writeUInt32BE(4096, 16);
  head[20] = asPub.length;
  return Buffer.concat([head, asPub, body]);
}

export function newVapidKeys(): Vapid {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" });
  return { privateJwk, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(privateJwk.x!), unb64u(privateJwk.y!)])) };
}

/** CC_HOME/vapid.json, created on first use. A new pair would orphan every subscription, so it is never rotated. */
export function loadVapid(home: string): Vapid {
  const file = join(home, "vapid.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(newVapidKeys()), { mode: 0o600, flag: "wx" });
  chmod600(file);
  return JSON.parse(readFileSync(file, "utf8")) as Vapid;
}

/** RFC 8292 Authorization header. `aud` is the endpoint's origin; exp must be < 24 h. */
export function vapidHeader(endpoint: string, vapid: Vapid, subject: string, now = Date.now()): string {
  const seg = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const data = `${seg({ typ: "JWT", alg: "ES256" })}.${seg({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const sig = sign("sha256", Buffer.from(data), { key: createPrivateKey({ key: vapid.privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Resolves "ok", or "gone" when the push service says the subscription is dead (delete it). Throws otherwise. */
export async function sendPush(sub: PushSub, msg: PushMessage, vapid: Vapid, subject: string, doFetch: typeof fetch = fetch): Promise<"ok" | "gone"> {
  const res = await doFetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(sub.endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "3600",
      Urgency: msg.urgency,
    },
    body: new Uint8Array(encryptPayload(JSON.stringify({ t: msg.t, b: msg.b, tag: msg.tag, u: msg.u }), sub.p256dh, sub.auth)),
    signal: AbortSignal.timeout(10_000),
  });
  // 403: the subscription is bound to another VAPID key (rotated vapid.json); it never recovers.
  if (res.status === 403 || res.status === 404 || res.status === 410) return "gone";
  // Status only: the endpoint URL is a capability and the body is the push service's business.
  if (!res.ok) throw new Error(`push service ${new URL(sub.endpoint).host} answered ${res.status}`);
  return "ok";
}

// ---- what to push ----

const DAY = 86_400_000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const itemUrl = (tag: string) => `/#item=${encodeURIComponent(tag)}`;

/**
 * Messages for CC items in `next` whose id is not in `sent` yet: CC threads that need you or finished,
 * agent tasks awaiting approval, workflow runs waiting on you, CC tasks that failed without a thread, and alerts.
 * Mutates `sent` (id -> sent ms): adds the new ids and forgets ids older than 24 h, so an item
 * still open a day later is pushed again as a reminder.
 * Tags (also the `/#item=` key): thread key "<machineId>:<threadId>", "task:<taskId>", "alert:<alertKey>",
 * "workflow:<runId>:<nodeId|approval>".
 */
export function notifyDiff(sent: Map<string, number>, next: HomeView, now: number): PushMessage[] {
  for (const [id, at] of sent) if (now - at > DAY) sent.delete(id);
  const out: PushMessage[] = [];
  const add = (id: string, tag: string, t: string, b: string, urgency: PushMessage["urgency"]) => {
    if (sent.has(id)) return;
    sent.set(id, now);
    out.push({ id, tag, t: clip(t, 100), b: clip(b, 200), u: itemUrl(tag), urgency });
  };
  for (const item of next.needsYou) {
    if (item.kind === "thread") {
      const th = item.thread;
      if (!th.taskId) continue;
      if (item.reason === "plan") add(`plan:${th.key}`, th.key, `Plan listo: ${th.title}`, "Revisá el plan en T3.", "high");
      else add(`ask:${th.key}:${th.pending?.id ?? ""}`, th.key, `Te necesita: ${th.title}`, th.pending?.summary ?? (item.reason === "input" ? "Falta tu respuesta" : "Falta tu aprobación"), "high");
    } else if (item.kind === "task_approval") {
      const task = item.task;
      add(`approve:${task.id}`, `task:${task.id}`, `Aprobá: ${task.title}`, `${task.source} · ${task.machineLabel} · ${task.projectTitle}`, "high");
    } else if (item.kind === "workflow") {
      add(item.key, item.key, `Flujo: ${item.title}`, item.text, "high");
    } else {
      add(`alert:${item.alert.key}`, `alert:${item.alert.key}`, "Alerta del Command Center", item.alert.message, "high");
    }
  }
  for (const th of next.done) {
    if (th.taskId) add(`done:${th.key}`, th.key, `${th.failed ? "Falló" : "Listo"}: ${th.title}`, th.preview ?? "", "normal");
  }
  for (const task of next.queue) {
    if (task.status === "failed" && task.threadId === null) add(`failed:${task.id}`, `task:${task.id}`, `Falló: ${task.title}`, task.error ?? "", "normal");
  }
  return out;
}

// ---- service ----

const MAX_PER_MIN = 10;

export interface PushOptions {
  db: DatabaseSync;
  home: string;
  /** VAPID `sub`: CC_PUSH_SUBJECT (mailto:) or the CC's https public URL. */
  subject: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createPush(opts: PushOptions) {
  const { db, subject } = opts;
  const now = opts.now ?? Date.now;
  db.exec(`create table if not exists push_subs(
    endpoint text primary key,
    p256dh text not null,
    auth text not null,
    label text,
    created_at text not null,
    last_ok_at text
  )`);
  const vapid = loadVapid(opts.home);
  const sent = new Map(Object.entries(kvGet<Record<string, number>>(db, "push_sent") ?? {}));
  let windowStart = 0;
  let count = 0;

  /** Sends one message to every subscription. Dead ones are deleted; other failures are logged. */
  async function send(msg: PushMessage): Promise<number> {
    const subs = db.prepare("select endpoint, p256dh, auth from push_subs").all() as unknown as PushSub[];
    const results = await Promise.allSettled(subs.map((s) => sendPush(s, msg, vapid, subject, opts.fetch)));
    let ok = 0;
    results.forEach((r, i) => {
      const endpoint = subs[i]!.endpoint;
      if (r.status === "rejected") return console.error(`[cc] push failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      if (r.value === "gone") db.prepare("delete from push_subs where endpoint = ?").run(endpoint);
      else {
        ok++;
        db.prepare("update push_subs set last_ok_at = ? where endpoint = ?").run(new Date(now()).toISOString(), endpoint);
      }
    });
    return ok;
  }

  /** Global budget of 10 messages a minute. */
  function allowed(): boolean {
    const t = now();
    if (t - windowStart >= 60_000) [windowStart, count] = [t, 0];
    return ++count <= MAX_PER_MIN;
  }

  /** Call with every rebuilt HomeView (not only when SSE clients are connected). */
  async function notify(view: HomeView): Promise<void> {
    const before = JSON.stringify([...sent]);
    const msgs = notifyDiff(sent, view, now());
    if (JSON.stringify([...sent]) !== before) kvSet(db, "push_sent", Object.fromEntries(sent));
    // ponytail: over-budget messages are dropped (the Home view still shows them); add a "N more" summary if bursts matter.
    await Promise.all(msgs.filter(allowed).map(send));
  }

  const routes: Route[] = [
    { method: "GET", path: "/api/push/key", auth: "cookie", handler: (): PushApi["GET /api/push/key"]["res"] => ({ key: vapid.publicKey }) },
    {
      method: "POST",
      path: "/api/push/subscribe",
      auth: "cookie",
      handler: ({ req, body }): Ok => {
        const sub = parseSub(body);
        db.prepare(
          `insert into push_subs(endpoint, p256dh, auth, label, created_at) values (?, ?, ?, ?, ?)
           on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
        ).run(sub.endpoint, sub.p256dh, sub.auth, (req.headers["user-agent"] ?? "").slice(0, 200), new Date(now()).toISOString());
        return { ok: true };
      },
    },
    {
      method: "DELETE",
      path: "/api/push/subscribe",
      auth: "cookie",
      handler: ({ body }): Ok => {
        const endpoint = (body as { endpoint?: unknown } | undefined)?.endpoint;
        if (typeof endpoint !== "string") throw new HttpError(400, "bad_request", "endpoint required");
        db.prepare("delete from push_subs where endpoint = ?").run(endpoint);
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/push/test",
      auth: "cookie",
      handler: async (): Promise<PushApi["POST /api/push/test"]["res"]> => {
        if (!allowed()) throw new HttpError(429, "rate_limited", "Demasiadas notificaciones este minuto, probá de nuevo en un rato");
        const tag = `test:${now()}`;
        return { sent: await send({ id: tag, tag, t: "Command Center", b: "Las notificaciones funcionan en este dispositivo.", u: "/#home", urgency: "normal" }) };
      },
    },
  ];

  return { routes, notify, send, publicKey: vapid.publicKey };
}

function onCurve(p256dh: string): boolean {
  try {
    const e = createECDH("prime256v1");
    e.generateKeys();
    e.computeSecret(unb64u(p256dh));
    return true;
  } catch {
    return false;
  }
}

function parseSub(body: unknown): PushSub {
  const b = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  const { endpoint } = b ?? {};
  const { p256dh, auth } = b?.keys ?? {};
  const valid =
    typeof endpoint === "string" &&
    endpoint.length <= 2000 &&
    URL.canParse(endpoint) &&
    new URL(endpoint).protocol === "https:" &&
    typeof p256dh === "string" &&
    typeof auth === "string" &&
    unb64u(p256dh).length === 65 &&
    onCurve(p256dh) &&
    unb64u(auth).length === 16;
  if (!valid) throw new HttpError(400, "bad_request", "Invalid push subscription");
  return { endpoint, p256dh, auth };
}
