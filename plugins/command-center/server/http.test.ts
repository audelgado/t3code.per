import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintPairing } from "./auth.ts";
import { openDb } from "./db.ts";
import { createServer, HttpError, sse, type Route } from "./http.ts";

const PUBLIC = "https://cc.tailnet.ts.net:8443";
const HOST = "cc.tailnet.ts.net:8443";
const ORIGIN = "https://cc.tailnet.ts.net:8443";

async function setup(t: { after(fn: () => Promise<void> | void): void }, routes: Route[] = []) {
  const home = mkdtempSync(join(tmpdir(), "cc-http-"));
  const staticDir = join(home, "dist");
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>CC</title>");
  writeFileSync(join(staticDir, "assets", "app-abc.js"), "console.log(1)");
  writeFileSync(join(home, "secret.txt"), "nope");
  const db = openDb(home);
  const server = await createServer({
    routes,
    publicUrl: PUBLIC,
    db,
    staticDir,
    port: 0,
    verifyBearer: (token) => (token === "agent-token" ? "hermes" : null),
    activeRuns: () => ({ "env-1": 2 }),
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { server, db, port: (server.address() as AddressInfo).port };
}

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: any;
}
function call(server: Server, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const { port } = server.address() as AddressInfo;
  return new Promise((ok, ko) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, ...opts.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, text, json: text && res.headers["content-type"]?.startsWith("application/json") ? JSON.parse(text) : undefined }));
    });
    req.on("error", ko);
    req.end(opts.body);
  });
}
const post = (server: Server, path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(server, "POST", path, { headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function pair(server: Server, db: ReturnType<typeof openDb>) {
  const res = await post(server, "/api/pair", { token: mintPairing(db) });
  assert.equal(res.status, 200);
  return String(res.headers["set-cookie"]?.[0]).split(";")[0]!;
}

const echo: Route = { method: "POST", path: "/api/tasks/:id/note", auth: "cookie", handler: ({ params, body }) => ({ id: params.id, body }) };
const view: Route = { method: "GET", path: "/api/view", auth: "cookie", handler: () => ({ view: 1 }) };

test("binds 127.0.0.1 and serves /healthz without secrets", async (t) => {
  const { server } = await setup(t);
  assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
  const res = await call(server, "GET", "/healthz", { headers: { host: "127.0.0.1" } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true, activeRuns: { "env-1": 2 } });
});

test("pair -> cookie -> cookie route; pairing token is single use; logout ends the session", async (t) => {
  const { server, db } = await setup(t, [view, echo]);
  assert.equal((await call(server, "GET", "/api/view")).status, 401);
  const token = mintPairing(db);
  const first = await post(server, "/api/pair", { token });
  assert.equal(first.status, 200);
  const setCookie = String(first.headers["set-cookie"]?.[0]);
  assert.match(setCookie, /^cc_session=.+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000$/);
  assert.equal((await post(server, "/api/pair", { token })).status, 401, "single use");
  const cookie = setCookie.split(";")[0]!;
  const ok = await call(server, "GET", "/api/view", { headers: { cookie } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { view: 1 });
  assert.equal(ok.headers["cache-control"], "no-store");
  const note = await post(server, "/api/tasks/a%20b/note", { x: 1 }, { cookie });
  assert.deepEqual(note.json, { id: "a b", body: { x: 1 } });
  assert.equal((await post(server, "/api/logout", {}, { cookie })).status, 200);
  assert.equal((await call(server, "GET", "/api/view", { headers: { cookie } })).status, 401);
});

test("expired pairing token is rejected", async (t) => {
  const { server, db } = await setup(t);
  assert.equal((await post(server, "/api/pair", { token: mintPairing(db, -1) })).status, 401);
});

test("wrong Host or Origin is 403, even with a valid cookie", async (t) => {
  const { server, db, port } = await setup(t, [view, echo]);
  const cookie = await pair(server, db);
  const bad: Record<string, string>[] = [{ host: "evil.com" }, { host: `127.0.0.1:${port}` }, { origin: "https://evil.com" }, { origin: "null" }, { origin: "https://cc.tailnet.ts.net" }];
  for (const headers of bad) {
    const res = await call(server, "GET", "/api/view", { headers: { cookie, ...headers } });
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.equal(res.json.error.code, "forbidden");
  }
  assert.equal((await post(server, "/api/pair", { token: mintPairing(db) }, { origin: "https://evil.com" })).status, 403);
});

test("bearer routes: valid token from the public host or 127.0.0.1:<port>; cookie alone is not enough", async (t) => {
  const route: Route = { method: "POST", path: "/mcp", auth: "bearer", handler: ({ agent }) => ({ agent }) };
  const { server, db, port } = await setup(t, [route]);
  const auth = { authorization: "Bearer agent-token" };
  assert.deepEqual((await call(server, "POST", "/mcp", { headers: auth })).json, { agent: "hermes" });
  assert.deepEqual((await call(server, "POST", "/mcp", { headers: { ...auth, host: `127.0.0.1:${port}` } })).json, { agent: "hermes" });
  assert.equal((await call(server, "POST", "/mcp", { headers: { ...auth, host: "localhost:1" } })).status, 403);
  assert.equal((await call(server, "POST", "/mcp", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call(server, "POST", "/mcp", { headers: { cookie: await pair(server, db) } })).status, 401);
});

test("bodies over 64 KB get 413; bad JSON 400; handler errors map to {error}", async (t) => {
  const boom: Route = { method: "GET", path: "/api/boom", auth: "cookie", handler: () => { throw new HttpError(409, "conflict", "Nope"); } };
  const crash: Route = { method: "GET", path: "/api/crash", auth: "cookie", handler: () => { throw new Error("kaput"); } };
  const { server, db } = await setup(t, [echo, boom, crash]);
  const cookie = await pair(server, db);
  const big = await post(server, "/api/tasks/x/note", { pad: "x".repeat(65 * 1024) }, { cookie });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, "too_large");
  const chunked = await new Promise<number>((ok, ko) => {
    const { port } = server.address() as AddressInfo;
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/api/tasks/x/note", headers: { host: HOST, origin: ORIGIN, cookie } }, (res) => {
      res.resume();
      ok(res.statusCode!);
    });
    req.on("error", ko);
    for (let i = 0; i < 70; i++) req.write("x".repeat(1024));
    req.end();
  });
  assert.equal(chunked, 413, "chunked body without content-length");
  const bad = await call(server, "POST", "/api/tasks/x/note", { headers: { origin: ORIGIN, cookie }, body: "{nope" });
  assert.equal(bad.json.error.code, "bad_json");
  assert.deepEqual((await call(server, "GET", "/api/boom", { headers: { cookie } })).json, { error: { code: "conflict", message: "Nope" } });
  const res500 = await call(server, "GET", "/api/crash", { headers: { cookie } });
  assert.deepEqual(res500.json, { error: { code: "internal", message: "Internal error" } });
  assert.equal((await call(server, "GET", "/api/missing", { headers: { cookie } })).status, 404);
});

test("pairing is limited to 10 attempts per minute globally", async (t) => {
  const { server } = await setup(t);
  for (let i = 0; i < 10; i++) assert.equal((await post(server, "/api/pair", { token: "bad" })).status, 401);
  assert.equal((await post(server, "/api/pair", { token: "bad" })).status, 429);
});

test("SSE delivers frames and unsubscribes on disconnect", async (t) => {
  let send: ((d: unknown) => void) | undefined;
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const events: Route = {
    method: "GET",
    path: "/api/events",
    auth: "cookie",
    handler: ({ res }) =>
      sse(res, (s) => {
        send = s;
        s({ n: 1 });
        return () => release();
      }),
  };
  const { server, db, port } = await setup(t, [events]);
  const cookie = await pair(server, db);
  const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: HOST, cookie } });
  const res = await new Promise<import("node:http").IncomingMessage>((ok, ko) => req.on("response", ok).on("error", ko).end());
  assert.equal(res.headers["content-type"], "text/event-stream");
  res.setEncoding("utf8");
  const frames: string[] = [];
  const { promise: two, resolve: gotTwo } = Promise.withResolvers<void>();
  res.on("data", (c: string) => {
    frames.push(c);
    if (frames.join("").split("\n\n").length > 2) gotTwo();
  });
  send!({ n: 2 });
  await two;
  assert.equal(frames.join(""), 'data: {"n":1}\n\ndata: {"n":2}\n\n');
  req.on("error", () => {});
  req.destroy();
  await released;
});

test("static: / and SPA paths serve index.html no-cache, /assets immutable, no traversal", async (t) => {
  const { server } = await setup(t);
  const root = await call(server, "GET", "/");
  assert.equal(root.status, 200);
  assert.match(root.text, /<title>CC<\/title>/);
  assert.equal(root.headers["cache-control"], "no-cache");
  assert.equal(root.headers["content-type"], "text/html; charset=utf-8");
  assert.match((await call(server, "GET", "/pair")).text, /<title>CC/);
  const asset = await call(server, "GET", "/assets/app-abc.js");
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(asset.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal((await call(server, "GET", "/assets/gone.js")).status, 404);
  for (const p of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt"]) {
    const res = await call(server, "GET", p);
    assert.ok(!res.text.includes("nope"), p);
  }
  assert.equal((await call(server, "GET", "/api/nothing")).status, 404, "unknown /api is never the SPA");
});
