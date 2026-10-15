import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { T3_CONTRACT } from "../server/t3link.ts";
import { parseArgs, redactFrame } from "./contract-check.ts";

const script = join(import.meta.dirname, "contract-check.ts");
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("redactFrame hides secret keys and bearer/ticket text", () => {
  const out = redactFrame(JSON.stringify({ a: { ticket: "t1", n: 1 }, url: "/ws?wsTicket=abc&x=1", h: "Bearer zzz" }));
  assert.ok(!/t1|abc|zzz/.test(out));
  assert.equal(JSON.parse(out).a.n, 1);
  assert.ok(!redactFrame("GET /ws?wsTicket=abc").includes("abc"));
});

test("parseArgs rejects unknown and valueless flags", () => {
  assert.equal(parseArgs(["--nope"]), null);
  assert.equal(parseArgs(["--local"]), null);
  assert.deepEqual(parseArgs(["--live"]), { live: true });
});

test("--probe without --i-know-this-launches exits 2", () => {
  assert.equal(run("--probe", "http://127.0.0.1:1", "--project", "p").status, 2);
});

test("--local passes on a fixture and exits 1 once a needle is gone", () => {
  const root = mkdtempSync(join(tmpdir(), "cc-contract-"));
  try {
    const files = new Map<string, string>();
    for (const n of T3_CONTRACT) files.set(n.file, (files.get(n.file) ?? "") + "\n" + n.needle);
    for (const [file, text] of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    assert.equal(run("--local", root).status, 0);
    const [file] = [...files.keys()];
    writeFileSync(join(root, file!), readFileSync(join(root, file!), "utf8").replace(T3_CONTRACT[0]!.needle, "x"));
    const r = run("--local", root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /MISS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
