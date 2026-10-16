import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "./db.ts";
import type { Ctx } from "./http.ts";
import { b64u, createPush, encryptPayload, loadVapid, newVapidKeys, notifyDiff, vapidHeader, type PushMessage } from "./push.ts";
import type { HomeView, TaskItem, ThreadItem } from "./types.ts";

test("encryptPayload matches the RFC 8291 section 5 vector", () => {
  const got = encryptPayload(
    "When I grow up, I want to be a watermelon",
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    "BTBZMqHH6r4Tts7J_aSIgg",
    { asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url") },
  );
  assert.equal(
    b64u(got),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

test("encryptPayload round-trips the way a browser decrypts it", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const msg = encryptPayload('{"t":"hi"}', b64u(ua.getPublicKey()), b64u(auth));
  const salt = msg.subarray(0, 16);
  const asPub = msg.subarray(21, 21 + msg[20]!);
  const ct = msg.subarray(21 + msg[20]!);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]);
  const ikm = Buffer.from(hkdfSync("sha256", ua.computeSecret(asPub), auth, info, 32));
  const d = createDecipheriv(
    "aes-128-gcm",
    Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16)),
    Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12)),
  );
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2);
  assert.equal(plain.subarray(0, -1).toString(), '{"t":"hi"}');
});

test("VAPID JWT verifies with the public key the browser gets", () => {
  const keys = newVapidKeys();
  const now = Date.UTC(2026, 0, 1);
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(vapidHeader("https://web.push.apple.com/abc/def", keys, "mailto:me@example.com", now))!;
  assert.equal(k, keys.publicKey);
  const [h, c, s] = t!.split(".") as [string, string, string];
  const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: keys.privateJwk.x, y: keys.privateJwk.y }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url").toString()), { aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "mailto:me@example.com" });
});

// ---- notifyDiff ----

const thread = (key: string, taskId: string | null, extra: Partial<ThreadItem> = {}): ThreadItem => ({
  key,
  machineId: key.split(":")[0]!,
  threadId: key.split(":")[1]!,
  projectId: "p",
  title: `T ${key}`,
  status: "running",
  taskId,
  pending: null,
  planReady: false,
  waitingUntil: null,
  preview: null,
  failed: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  appUrl: "",
  webUrl: null,
  ...extra,
});
const pending = { id: "req-1", kind: "command", summary: "rm -rf build", createdAt: "2026-01-01T00:00:00.000Z" };
const view = (p: Partial<HomeView> = {}): HomeView => ({ machines: [], needsYou: [], running: [], done: [], queue: [], ...p });

test("notifyDiff pushes CC items once per key and ignores non-CC threads", () => {
  const sent = new Map<string, number>();
  const v = view({
    needsYou: [
      { kind: "thread", reason: "approval", since: "", thread: thread("m:cc", "task-1", { pending }) },
      { kind: "thread", reason: "approval", since: "", thread: thread("m:other", null, { pending }) },
      { kind: "task_approval", since: "", task: { id: "task-2", title: "Agent idea", source: "agent:hermes", machineLabel: "VPS", projectTitle: "web" } as unknown as TaskItem },
      { kind: "workflow", key: "workflow:r1:ok", since: "", runId: "r1", title: "Release", text: 'Pass "ok"?' },
      { kind: "alert", since: "", alert: { key: "offline:m", kind: "offline", machineId: "m", message: "VPS: offline", since: "" } },
    ],
    done: [thread("m:done", "task-3", { status: "failed", failed: true, preview: "boom" }), thread("m:done-other", null, { status: "completed" })],
  });
  const first = notifyDiff(sent, v, 1_000);
  assert.deepEqual(
    first.map((m) => [m.tag, m.t, m.urgency]),
    [
      ["m:cc", "Te necesita: T m:cc", "high"],
      ["task:task-2", "Aprobá: Agent idea", "high"],
      ["workflow:r1:ok", "Flujo: Release", "high"],
      ["alert:offline:m", "Alerta del Command Center", "high"],
      ["m:done", "Falló: T m:done", "normal"],
    ],
  );
  assert.equal(first[0]!.b, "rm -rf build");
  assert.equal(first[0]!.u, "/#item=m%3Acc");
  assert.deepEqual(notifyDiff(sent, v, 2_000), []);

  // A new request on the same thread is a new event; the same thread finishing replaces its notification by tag.
  const again = notifyDiff(sent, view({ needsYou: [{ kind: "thread", reason: "input", since: "", thread: thread("m:cc", "task-1", { pending: { ...pending, id: "req-2", summary: null } }) }] }), 3_000);
  assert.deepEqual(again.map((m) => [m.tag, m.b]), [["m:cc", "Falta tu respuesta"]]);

  // After 24 h an item still open is pushed again as a reminder.
  assert.equal(notifyDiff(sent, v, 1_000 + 86_400_001).length, 5);
});

// ---- service ----

function setup(t: { after(fn: () => void): void }, fetchImpl: typeof fetch) {
  const home = mkdtempSync(join(tmpdir(), "cc-push-"));
  const db = openDb(home);
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  const push = createPush({ db, home, subject: "https://cc.example", fetch: fetchImpl });
  const route = (method: string, path: string) => push.routes.find((r) => r.method === method && r.path === path)!;
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const subscribe = (endpoint: string) =>
    route("POST", "/api/push/subscribe").handler({
      req: { headers: { "user-agent": "phone" } },
      body: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(Buffer.alloc(16, 1)) } },
    } as unknown as Ctx);
  return { home, db, push, route, subscribe };
}

const msg: PushMessage = { id: "x", tag: "x", t: "t", b: "b", u: "/", urgency: "high" };

test("410, 404 and 403 delete the subscription; 201 keeps it", async (t) => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string> });
    return new Response(null, { status: url.includes("gone") ? 410 : url.includes("missing") ? 404 : url.includes("rekeyed") ? 403 : 201 });
  }) as typeof fetch;
  const { db, push, subscribe } = setup(t, fakeFetch);
  subscribe("https://push.example/gone");
  subscribe("https://push.example/missing");
  subscribe("https://push.example/rekeyed");
  subscribe("https://push.example/live");
  assert.equal(await push.send(msg), 1);
  const rows = db.prepare("select endpoint, label, last_ok_at from push_subs").all();
  assert.deepEqual(rows.map((r) => [r.endpoint, r.label, typeof r.last_ok_at]), [["https://push.example/live", "phone", "string"]]);
  assert.equal(seen[0]!.headers.TTL, "3600");
  assert.equal(seen[0]!.headers.Urgency, "high");
  assert.match(seen[0]!.headers.Authorization!, /^vapid t=.+, k=/);
});

test("subscribe validates input; vapid.json is created once and reused", (t) => {
  const { home, push, route, subscribe } = setup(t, fetch);
  assert.throws(() => subscribe("http://push.example/x"), /Invalid push subscription/);
  const offCurve = b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]));
  assert.throws(
    () => route("POST", "/api/push/subscribe").handler({
      req: { headers: {} },
      body: { endpoint: "https://push.example/x", keys: { p256dh: offCurve, auth: b64u(Buffer.alloc(16, 1)) } },
    } as unknown as Ctx),
    /Invalid push subscription/,
  );
  assert.equal(loadVapid(home).publicKey, push.publicKey);
});

test("notify persists sent ids and keeps to 10 pushes a minute", async (t) => {
  let posts = 0;
  const { home, db, push, subscribe } = setup(t, (async () => (posts++, new Response(null, { status: 201 }))) as unknown as typeof fetch);
  subscribe("https://push.example/live");
  const approvals = Array.from({ length: 12 }, (_, i) => ({ kind: "task_approval" as const, since: "", task: { id: `t${i}`, title: "x", source: "agent:a", machineLabel: "m", projectTitle: "p" } as unknown as TaskItem }));
  await push.notify(view({ needsYou: approvals }));
  assert.equal(posts, 10);
  await push.notify(view({ needsYou: approvals }));
  assert.equal(posts, 10);
  // A restarted service remembers what it already sent.
  const again = createPush({ db, home, subject: "https://cc.example", fetch: (async () => (posts++, new Response(null, { status: 201 }))) as unknown as typeof fetch });
  await again.notify(view({ needsYou: approvals }));
  assert.equal(posts, 10);
});
