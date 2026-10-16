import assert from "node:assert/strict";
import { test } from "node:test";
import { kvSet, openDb } from "./db.ts";
import { createHealth } from "./health.ts";
import { T3_CONTRACT } from "./t3link.ts";
import type { Machine, T3Link } from "./types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const machine = { id: "m1", label: "VPS" } as Machine;

function setup(opts: { files?: (f: string) => string | null; fail?: boolean; expiresAt?: string | null } = {}) {
  const db = openDb(mkdtempSync(join(tmpdir(), "cc-health-")));
  let version = "0.3.1";
  let clock = NOW;
  const reads: string[] = [];
  let sessions = 0;
  const link = {
    get state() {
      return { status: "online", serverVersion: version };
    },
    session: async () => (sessions++, { expiresAt: opts.expiresAt ?? null, scopes: [] }),
  } as unknown as T3Link;
  const all = new Map(T3_CONTRACT.map((n) => [n.file, ""]));
  for (const n of T3_CONTRACT) all.set(n.file, all.get(n.file) + n.needle + "\n");
  const health = createHealth({
    db,
    targets: () => [{ machine, link }],
    now: () => clock,
    readerFor: (ref) => async (file) => {
      reads.push(ref);
      if (opts.fail) throw new Error("network");
      return opts.files ? opts.files(file) : (all.get(file) ?? null);
    },
  });
  return { health, db, reads, setVersion: (v: string) => (version = v), advance: (ms: number) => (clock += ms), sessions: () => sessions };
}

test("contract miss gives one alert per version", async () => {
  const s = setup({ files: () => "nothing relevant" });
  await s.health.tick();
  await s.health.tick();
  const a = s.health.alerts().filter((x) => x.kind === "contract_break");
  assert.equal(a.length, 1);
  assert.match(a[0]!.message, /0\.3\.1/);
  assert.equal(new Set(s.reads).size, 1);
  assert.deepEqual(new Set(s.reads), new Set(["v0.3.1"]));
  s.setVersion("0.3.2");
  await s.health.tick();
  assert.equal(s.health.alerts()[0]!.key.endsWith("0.3.2"), true);
});

test("a version with no upstream tag (every read null) gives no alert", async () => {
  const s = setup({ files: () => null });
  await s.health.tick();
  assert.deepEqual(s.health.alerts(), []);
});

test("matching contract gives no alert", async () => {
  const s = setup();
  await s.health.tick();
  assert.deepEqual(s.health.alerts(), []);
});

test("updating contract checks refreshes stale warnings without a T3 version change", async () => {
  const s = setup();
  kvSet(s.db, "health:contract:m1", { version: "0.3.1", since: new Date(NOW).toISOString(), misses: ["threadLinks appUrl"] });
  assert.equal(s.health.alerts().length, 1);
  await s.health.tick();
  assert.deepEqual(s.health.alerts(), []);
  const reads = s.reads.length;
  await s.health.tick();
  assert.equal(s.reads.length, reads);
});

test("network error gives no alert and is retried", async () => {
  const s = setup({ fail: true });
  await s.health.tick();
  assert.deepEqual(s.health.alerts(), []);
  const n = s.reads.length;
  await s.health.tick();
  assert.ok(s.reads.length > n);
});

test("token 10 days from expiry alerts; checked once a day", async () => {
  const s = setup({ expiresAt: new Date(NOW + 10 * 86_400_000).toISOString() });
  await s.health.tick();
  await s.health.tick();
  assert.equal(s.sessions(), 1);
  assert.equal(s.health.alerts().filter((x) => x.kind === "token_expiring").length, 1);
  s.advance(86_400_000);
  await s.health.tick();
  assert.equal(s.sessions(), 2);
});

test("token 60 days from expiry does not alert", async () => {
  const s = setup({ expiresAt: new Date(NOW + 60 * 86_400_000).toISOString() });
  await s.health.tick();
  assert.equal(s.health.alerts().filter((x) => x.kind === "token_expiring").length, 0);
});
