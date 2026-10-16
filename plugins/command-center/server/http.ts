// The CC HTTP server: route table with per-route auth, JSON bodies, SSE and the built PWA.
// Binds 127.0.0.1 only; the tailnet reaches it through `tailscale serve`.
import { createReadStream, statSync, type Stats } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { bearerToken, isAuthed, logout, originOk, redeem } from "./auth.ts";

export const MAX_BODY = 64 * 1024;

/** Throw from a handler to answer `{error: {code, message}}` with `status`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body (≤64 KB); undefined when empty or for GET. Validate it in the handler. */
  body: unknown;
  /** Bearer routes: what verifyBearer returned for the token. Null elsewhere. */
  agent: string | null;
}

export interface Route {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** "/api/tasks/:id" style; params arrive decoded in ctx.params. */
  path: string;
  /**
   * public: no checks. cookie: Host/Origin must match CC_PUBLIC_URL plus a session cookie.
   * bearer: same Host/Origin rule (Host 127.0.0.1:<port> also allowed, for agents on the VPS) plus a valid bearer.
   * GET handlers must not mutate: a cross-site top-level navigation carries the Lax cookie and no Origin.
   */
  auth: "public" | "cookie" | "bearer";
  /** The return value is sent as JSON 200 (undefined → 204), unless the handler already responded (e.g. sse). */
  handler(ctx: Ctx): unknown;
}

export interface ServerOptions {
  routes: Route[];
  /** CC_PUBLIC_URL, e.g. https://vps.tailnet.ts.net:8443. */
  publicUrl: string;
  db: DatabaseSync;
  /** web/dist. */
  staticDir: string;
  port: number;
  /** Maps a bearer token to its agent label, or null when unknown. Without it every bearer route answers 401. */
  verifyBearer?: (token: string) => string | null;
  /** For /healthz: active runs per machine id. */
  activeRuns?: () => Record<string, number>;
}

/** Listens on 127.0.0.1:`port` (0 = any free port) and resolves once bound. */
export async function createServer(opts: ServerOptions): Promise<Server> {
  const routes = [...builtins(opts), ...opts.routes].map((r) => ({ ...r, parts: r.path.split("/") }));
  const server = createHttpServer((req, res) => {
    handle(req, res).catch((e: unknown) => fail(req, res, e));
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    const url = new URL(req.url ?? "/", "http://cc");
    const segments = url.pathname.split("/");
    let route: (typeof routes)[number] | undefined;
    let params: Record<string, string> | null = null;
    for (const r of routes) {
      if (r.method === req.method && (params = match(r.parts, segments))) {
        route = r;
        break;
      }
    }
    if (!route || !params) {
      if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) return serveStatic(opts.staticDir, url.pathname, req, res);
      throw new HttpError(404, "not_found", "Not found");
    }
    let agent: string | null = null;
    if (route.auth !== "public") {
      const loopback = route.auth === "bearer" ? `127.0.0.1:${(server.address() as AddressInfo).port}` : undefined;
      if (!originOk(req, opts.publicUrl, loopback)) throw new HttpError(403, "forbidden", "Host or Origin not allowed");
      if (route.auth === "cookie" && !isAuthed(opts.db, req)) throw new HttpError(401, "unauthorized", "Not paired");
      if (route.auth === "bearer") {
        const token = bearerToken(req);
        agent = token && opts.verifyBearer ? opts.verifyBearer(token) : null;
        if (!agent) throw new HttpError(401, "unauthorized", "Invalid bearer token");
      }
    }
    const body = req.method === "GET" ? undefined : await readBody(req);
    const result = await route.handler({ req, res, url, params, body, agent });
    if (!res.headersSent) json(res, result === undefined ? 204 : 200, result);
  }

  await new Promise<void>((ok, ko) => {
    server.once("error", ko);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", ko);
      ok();
    });
  });
  return server;
}

function builtins(opts: ServerOptions): Route[] {
  // Global, not per IP: every request arrives from 127.0.0.1 through tailscale serve.
  let windowStart = 0;
  let attempts = 0;
  return [
    { method: "GET", path: "/healthz", auth: "public", handler: () => ({ ok: true, activeRuns: opts.activeRuns?.() ?? {} }) },
    {
      method: "POST",
      path: "/api/pair",
      auth: "public",
      handler: ({ req, res, body }) => {
        // Checked here because pairing is public but sets the cookie: a foreign page must not plant a session.
        if (!originOk(req, opts.publicUrl)) throw new HttpError(403, "forbidden", "Host or Origin not allowed");
        const now = Date.now();
        if (now - windowStart >= 60_000) [windowStart, attempts] = [now, 0];
        if (++attempts > 10) throw new HttpError(429, "rate_limited", "Demasiados intentos de vinculación, probá de nuevo en un minuto");
        const token = (body as { token?: unknown } | undefined)?.token;
        if (typeof token !== "string" || token.length > 200) throw new HttpError(400, "bad_request", "token required");
        const cookie = redeem(opts.db, token, (req.headers["user-agent"] ?? "").slice(0, 200));
        if (!cookie) throw new HttpError(401, "invalid_token", "El link de vinculación no es válido, ya se usó o venció");
        res.setHeader("set-cookie", cookie);
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/logout",
      auth: "cookie",
      handler: ({ req, res }) => {
        res.setHeader("set-cookie", logout(opts.db, req));
        return { ok: true };
      },
    },
  ];
}

function match(parts: string[], segments: string[]): Record<string, string> | null {
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of parts.entries()) {
    const seg = segments[i]!;
    if (part.startsWith(":")) {
      if (!seg) return null;
      params[part.slice(1)] = decodeURIComponent(seg);
    } else if (part !== seg) return null;
  }
  return params;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, ko) => {
    const tooLarge = () => new HttpError(413, "too_large", "Body over 64 KB");
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return ko(tooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) return void chunks.push(chunk);
      req.off("data", onData); // stop buffering; Node discards the rest
      ko(tooLarge());
    };
    req.on("data", onData);
    req.on("error", ko);
    req.on("end", () => {
      if (size > MAX_BODY) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return ok(undefined);
      try {
        ok(JSON.parse(text));
      } catch {
        ko(new HttpError(400, "bad_json", "Body is not valid JSON"));
      }
    });
  });
}

export function json(res: ServerResponse, status: number, data: unknown) {
  if (status === 204) return void res.writeHead(204, { "cache-control": "no-store" }).end();
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}

function fail(req: IncomingMessage, res: ServerResponse, e: unknown) {
  const err = e instanceof HttpError ? e : e instanceof URIError ? new HttpError(400, "bad_request", "Malformed URL") : null;
  // Path only: queries are never logged. Handler errors must not carry tokens.
  if (!err) console.error(`[cc] ${req.method} ${(req.url ?? "").split("?")[0]} failed: ${e instanceof Error ? e.message : String(e)}`);
  if (res.headersSent) return void res.end();
  if (err?.status === 413) res.setHeader("connection", "close");
  json(res, err?.status ?? 500, { error: { code: err?.code ?? "internal", message: err?.message ?? "Internal error" } });
}

/**
 * Streams each value `subscribe` sends as an SSE `data:` frame, with a heartbeat every 25 s.
 * `subscribe` returns its unsubscribe, which runs when the client disconnects.
 */
export function sse(res: ServerResponse, subscribe: (send: (data: unknown) => void) => () => void) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
  res.flushHeaders();
  const unsubscribe = subscribe((data) => res.write(`data: ${JSON.stringify(data)}\n\n`));
  const heartbeat = setInterval(() => res.write(": hb\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function stat(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

/** index.html and other root files no-cache, hashed /assets immutable, extensionless paths fall back to index.html. */
function serveStatic(dir: string, pathname: string, req: IncomingMessage, res: ServerResponse) {
  const root = resolve(dir);
  let file = resolve(root, `.${decodeURIComponent(pathname)}`);
  if (file !== root && !file.startsWith(root + sep)) throw new HttpError(404, "not_found", "Not found");
  let st = stat(file);
  if (!st?.isFile()) {
    // A missing chunk must 404, never come back as HTML.
    if (extname(pathname)) throw new HttpError(404, "not_found", "Not found");
    file = join(root, "index.html");
    st = stat(file);
    if (!st?.isFile()) throw new HttpError(404, "not_found", "Web app not built");
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": st.size,
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
}
