import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, getLiveSnapshot } from "./api.ts";

test("la conexión expone fallos iniciales y datos antiguos, se recupera y conserva la autenticación", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  class Source {
    static CLOSED = 2;
    static instances: Source[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor() { Source.instances.push(this); }
    close() { this.readyState = 2; }
  }
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: Source });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "EventSource", previous); else Reflect.deleteProperty(globalThis, "EventSource"); });
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("sin red"); });
  await connect();
  assert.equal(getLiveSnapshot().connection, "retrying");
  assert.match(getLiveSnapshot().connectionError!, /sin red/);
  assert.equal(getLiveSnapshot().authed, null);

  const view = { machines: [], running: [], done: [], queue: [], needsYou: [] };
  fetch.mock.mockImplementation(async () => Response.json(view));
  await connect();
  const source = Source.instances.at(-1)!;
  source.onopen!();
  assert.equal(getLiveSnapshot().connection, "connected");
  source.onerror!();
  assert.equal(getLiveSnapshot().connection, "retrying");
  assert.deepEqual(getLiveSnapshot().view, view);
  source.onmessage!({ data: JSON.stringify({ ...view, assistantVersion: 2 }) });
  assert.equal(getLiveSnapshot().connection, "connected");
  assert.equal(getLiveSnapshot().connectionError, null);

  let finishOld!: (response: Response) => void;
  fetch.mock.mockImplementation(() => new Promise<Response>((resolve) => { finishOld = resolve; }));
  const oldAttempt = connect();
  fetch.mock.mockImplementation(async () => Response.json(view));
  await connect();
  finishOld(Response.json({ error: { message: "Sesión anterior vencida" } }, { status: 401 }));
  await oldAttempt;
  assert.equal(getLiveSnapshot().authed, true);
  assert.deepEqual(getLiveSnapshot().view, view);

  fetch.mock.mockImplementation(async () => Response.json({ error: { message: "Sesión vencida" } }, { status: 401 }));
  await connect();
  assert.equal(getLiveSnapshot().authed, false);
  assert.equal(getLiveSnapshot().view, null);
  const before = fetch.mock.callCount();
  t.mock.timers.tick(60_000);
  assert.equal(fetch.mock.callCount(), before);
});

test("un intento antiguo no reemplaza la conexión recuperada", async (t) => {
  let resolve!: (response: Response) => void;
  const fetch = t.mock.method(globalThis, "fetch", () => new Promise<Response>((done) => { resolve = done; }));
  const old = connect();
  fetch.mock.mockImplementation(async () => Response.json({ error: { message: "Sin sesión" } }, { status: 401 }));
  await connect();
  resolve(Response.json({ machines: [], running: [], done: [], queue: [], needsYou: [] }));
  await old;
  assert.equal(getLiveSnapshot().authed, false);
  assert.equal(getLiveSnapshot().view, null);
});
