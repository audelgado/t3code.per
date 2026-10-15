import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bearerToken, isAuthed, logout, mintPairing, originOk, redeem, sha256 } from "./auth.ts";
import { openDb } from "./db.ts";

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-auth-"));
  const db = openDb(home);
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return db;
}
const withCookie = (setCookie: string) => ({ headers: { cookie: `a=b; ${setCookie.split(";")[0]}` } });

test("pairing is single use and expires; only hashes are stored", (t) => {
  const db = setup(t);
  const token = mintPairing(db);
  assert.equal(db.prepare("select count(*) n from pairings where h = ?").get(token)?.n, 0, "raw token not stored");
  assert.equal(db.prepare("select count(*) n from pairings where h = ?").get(sha256(token))?.n, 1);
  const set = redeem(db, token);
  assert.match(set ?? "", /^cc_session=[\w-]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=15552000$/);
  assert.equal(redeem(db, token), null, "single use");
  assert.equal(redeem(db, "bogus"), null);
  assert.equal(redeem(db, mintPairing(db, -1)), null, "expired");
  const sid = set!.split(";")[0]!.split("=")[1]!;
  assert.equal(db.prepare("select count(*) n from sessions where h = ?").get(sid)?.n, 0, "raw session id not stored");
  assert.equal(db.prepare("select count(*) n from sessions where h = ?").get(sha256(sid))?.n, 1);
});

test("session cookie authenticates until logout; T3's cookie does not", (t) => {
  const db = setup(t);
  const req = withCookie(redeem(db, mintPairing(db))!);
  assert.equal(isAuthed(db, req), true);
  assert.equal(isAuthed(db, { headers: { cookie: "t3_session_abc=xyz" } }), false);
  assert.equal(isAuthed(db, { headers: {} }), false);
  assert.match(logout(db, req), /^cc_session=; .*Max-Age=0$/);
  assert.equal(isAuthed(db, req), false);
});

test("sessions older than 180 days are rejected", (t) => {
  const db = setup(t);
  const req = withCookie(redeem(db, mintPairing(db))!);
  db.prepare("update sessions set created = ?").run(Date.now() - 181 * 86_400_000);
  assert.equal(isAuthed(db, req), false);
});

test("originOk: Host must match, Origin absent or equal", () => {
  const url = "https://vps.tailnet.ts.net:8443";
  const h = "vps.tailnet.ts.net:8443";
  assert.equal(originOk({ headers: { host: h } }, url), true);
  assert.equal(originOk({ headers: { host: h, origin: `https://${h}` } }, url), true);
  assert.equal(originOk({ headers: { host: "evil.com" } }, url), false);
  assert.equal(originOk({ headers: { host: h, origin: "https://vps.tailnet.ts.net" } }, url), false, "T3's origin (:443) is not CC's");
  assert.equal(originOk({ headers: { host: h, origin: "null" } }, url), false);
  assert.equal(originOk({ headers: {} }, url), false);
  assert.equal(originOk({ headers: { host: "127.0.0.1:3900" } }, url), false);
  assert.equal(originOk({ headers: { host: "127.0.0.1:3900" } }, url, "127.0.0.1:3900"), true);
  assert.equal(originOk({ headers: { host: "vps.tailnet.ts.net" } }, "https://vps.tailnet.ts.net:443"), true, "default port omitted");
});

test("bearerToken", () => {
  assert.equal(bearerToken({ headers: { authorization: "Bearer abc.def" } }), "abc.def");
  assert.equal(bearerToken({ headers: { authorization: "bearer x" } }), "x");
  assert.equal(bearerToken({ headers: { authorization: "Basic x" } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
});
