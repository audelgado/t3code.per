// Phone -> CC auth: a one-time pairing token becomes a session cookie. Only sha256 hashes are stored.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { DatabaseSync } from "node:sqlite";

/** Never t3_session*: cookies are scoped by host, not port, so T3 on the same host would collide. */
export const COOKIE = "cc_session";
const SESSION_MS = 180 * 86_400_000;

type Req = { headers: IncomingHttpHeaders };

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** CLI `pair`: print `<CC_PUBLIC_URL>/pair#token=<returned>`. Single use, 5 min. */
export function mintPairing(db: DatabaseSync, ttlMs = 300_000): string {
  db.prepare("delete from pairings where exp <= ?").run(Date.now());
  const token = randomBytes(24).toString("base64url");
  db.prepare("insert into pairings(h, exp) values (?, ?)").run(sha256(token), Date.now() + ttlMs);
  return token;
}

/** Consumes a pairing token. Returns the Set-Cookie value, or null if the token is unknown, used or expired. */
export function redeem(db: DatabaseSync, token: string, label = ""): string | null {
  if (!db.prepare("delete from pairings where h = ? and exp > ? returning 1").get(sha256(token), Date.now())) return null;
  const sid = randomBytes(32).toString("base64url");
  db.prepare("insert into sessions(h, created, label) values (?, ?, ?)").run(sha256(sid), Date.now(), label);
  return `${COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

function sessionId(req: Req): string | undefined {
  return /(?:^|;\s*)cc_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}

export function isAuthed(db: DatabaseSync, req: Req): boolean {
  const sid = sessionId(req);
  return sid !== undefined && db.prepare("select 1 from sessions where h = ? and created > ?").get(sha256(sid), Date.now() - SESSION_MS) !== undefined;
}

/** Deletes the request's session. Returns the Set-Cookie value that clears the cookie. */
export function logout(db: DatabaseSync, req: Req): string {
  const sid = sessionId(req);
  if (sid) db.prepare("delete from sessions where h = ?").run(sha256(sid));
  return `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Host must be CC_PUBLIC_URL's host (or `alsoHost`), Origin absent or CC_PUBLIC_URL's origin.
 * Blocks DNS rebinding and cross-site requests; Origin "null" never matches.
 */
export function originOk(req: Req, publicUrl: string, alsoHost?: string): boolean {
  const url = new URL(publicUrl);
  const { host, origin } = req.headers;
  return (host === url.host || (alsoHost !== undefined && host === alsoHost)) && (origin === undefined || origin === url.origin);
}

/** The bearer token of `Authorization: Bearer <token>`; look it up by sha256(token). */
export function bearerToken(req: Req): string | null {
  return /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1] ?? null;
}
