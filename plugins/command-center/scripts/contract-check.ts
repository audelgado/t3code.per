// Checks the CC's assumptions about T3. Exit 0 ok, 1 a miss or failure, 2 bad usage.
//   --local <repoRoot> | --ref <gitRef> [--repo <dir>] | --github <ref>   static: every T3_CONTRACT needle
//   --live                                  each CC_HOME machine: session, first snapshot, counters (launches nothing)
//   --probe <apiUrl> --project <id> --i-know-this-launches   token on stdin; launches ONE thread, twice
//   --record <file>                         with --live/--probe: raw frames as JSONL, secrets redacted
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { listMachines, openDb, readToken } from "../server/db.ts";
import { checkContract, createLink, githubReader, type LinkDeps } from "../server/t3link.ts";
import type { LinkState, Machine, ShellUpdate, T3Link, ThreadRow } from "../server/types.ts";

const FLAGS = new Set(["live", "i-know-this-launches"]);
const VALUE = new Set(["local", "ref", "repo", "github", "probe", "project", "record"]);

export function parseArgs(argv: string[]): Record<string, string | true> | null {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]?.startsWith("--") ? argv[i]!.slice(2) : "";
    if (FLAGS.has(name)) out[name] = true;
    else if (VALUE.has(name) && argv[i + 1] !== undefined) out[name] = argv[++i]!;
    else return null;
  }
  return out;
}

const SECRET_KEY = /token|ticket|authorization|secret|cookie|password/i;
const SECRET_TEXT = /(wsTicket=|Bearer\s+)[^\s"&]+/g;

/** One raw frame with secret-looking keys and bearer/ticket text replaced. Non-JSON frames get the text pass only. */
export function redactFrame(data: string): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) ? "[redacted]" : walk(x)]));
    return typeof v === "string" ? v.replace(SECRET_TEXT, "$1[redacted]") : v;
  };
  try {
    return JSON.stringify(walk(JSON.parse(data)));
  } catch {
    return data.replace(SECRET_TEXT, "$1[redacted]");
  }
}

function recorder(file: string | undefined): LinkDeps {
  if (!file) return {};
  writeFileSync(file, "", { mode: 0o600 });
  return {
    onFrame: (direction, data) =>
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), direction, frame: redactFrame(data) }) + "\n"),
  };
}

// ---- static ----

function reader(args: Record<string, string | true>): ((file: string) => Promise<string | null>) | null {
  if (typeof args.local === "string") {
    const root = args.local;
    return async (file) => {
      try {
        return readFileSync(join(root, file), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };
  }
  if (typeof args.ref === "string") {
    const ref = args.ref;
    const cwd = typeof args.repo === "string" ? args.repo : ".";
    return async (file) => {
      const r = spawnSync("git", ["show", `${ref}:${file}`], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      if (r.error) throw r.error;
      return r.status === 0 ? r.stdout : null; // git exits 128 for a missing path or ref
    };
  }
  if (typeof args.github === "string") return githubReader(args.github);
  return null;
}

async function runStatic(read: (file: string) => Promise<string | null>): Promise<number> {
  const misses = await checkContract(read);
  for (const m of misses) console.log(`MISS ${m.file}\n  needle: ${m.needle.slice(0, 160)}\n  why: ${m.why}`);
  console.log(misses.length ? `${misses.length} contract needle(s) missing.` : "Contract needles all present.");
  return misses.length ? 1 : 0;
}

// ---- live ----

const TIMEOUT_MS = 30_000;

/** Resolves on the first authoritative snapshot; rejects on unauthorized/incompatible or timeout. */
function connect(
  machine: Machine,
  token: string,
  deps: LinkDeps,
  onShell?: (s: ShellUpdate) => void,
): Promise<{ link: T3Link; first: ShellUpdate }> {
  return new Promise((resolve, reject) => {
    let link: T3Link | undefined;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => (link?.close(), reject(new Error(`no snapshot within ${TIMEOUT_MS / 1000}s`)))),
      TIMEOUT_MS,
    );
    link = createLink(
      machine,
      token,
      {
        onShell: (_id, shell) => {
          onShell?.(shell);
          if (shell.authoritative) finish(() => resolve({ link: link!, first: shell }));
        },
        onState: (_id, s: LinkState) => {
          if (s.status === "unauthorized" || s.status === "incompatible")
            finish(() => (link?.close(), reject(new Error(`${s.status}: ${s.message ?? ""}`))));
        },
      },
      deps,
    );
  });
}

async function runLive(deps: LinkDeps): Promise<number> {
  const home = process.env.CC_HOME;
  if (!home) return usage("--live needs CC_HOME");
  const db = openDb(home);
  let failed = 0;
  try {
    for (const m of listMachines(db).filter((x) => x.enabled)) {
      const token = readToken(home, m.id);
      if (!token) {
        console.log(`FAIL ${m.label}: no token file`);
        failed++;
        continue;
      }
      try {
        const { link, first } = await connect(m, token, deps);
        const s = await link.session();
        console.log(
          `OK   ${m.label}: v${link.state.serverVersion ?? "?"}, ${first.projects.length} projects, ${first.threads.length} threads, ` +
            `dropped ${link.state.droppedRows}, unknown ${link.state.unknownItems}, expires ${s.expiresAt ?? "never"}, scopes ${s.scopes.join(",") || "none"}`,
        );
        if (link.state.degraded) failed++;
        link.close();
      } catch (error) {
        console.log(`FAIL ${m.label}: ${(error as Error).message}`);
        failed++;
      }
    }
  } finally {
    db.close();
  }
  return failed ? 1 : 0;
}

// ---- probe ----

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

async function runProbe(apiUrl: string, projectId: string, deps: LinkDeps): Promise<number> {
  const token = readFileSync(0, "utf8").trim();
  if (!token) return usage("--probe reads the T3 token from stdin");
  const desc = (await (await fetch(new URL("/.well-known/t3/environment", apiUrl))).json()) as { environmentId?: string };
  if (!desc.environmentId) throw new Error("descriptor has no environmentId");
  const machine: Machine = {
    id: desc.environmentId,
    label: "probe",
    apiUrl,
    webUrl: null,
    maxConcurrent: 1,
    enabled: true,
    serverVersion: null,
    tokenExpiresAt: null,
    createdAt: new Date().toISOString(),
  };
  const threadId = randomUUID();
  const commandId = randomUUID();
  let latest: ShellUpdate | undefined;
  const { link, first } = await connect(machine, token, deps, (s) => (latest = s));
  try {
    if (!first.projects.some((p) => p.id === projectId)) throw new Error(`project ${projectId} not on this environment`);
    const provider = (await link.providers()).find((p) => p.enabled && p.installed && p.models.length);
    const model = provider?.models.find((x) => x.isDefault) ?? provider?.models[0];
    if (!provider || !model) throw new Error("no enabled provider with a model");
    const input = {
      commandId,
      threadId,
      projectId,
      title: "CC contract probe",
      modelSelection: { instanceId: provider.instanceId, model: model.slug },
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      workspaceStrategy: { type: "root" as const },
      prompt: "Reply with the word OK",
    };
    await link.launch(input);
    await link.launch(input); // same ids: the command receipt must make this a no-op
    const mine = () => latest?.threads.filter((t) => t.id === threadId) ?? [];
    const start = Date.now();
    let row: ThreadRow | undefined;
    while (Date.now() - start < 5 * 60_000) {
      row = mine()[0];
      if (row && TERMINAL.has(row.status)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const count = mine().length;
    const result = row && TERMINAL.has(row.status) ? await link.readResult(threadId) : null;
    console.log(`threads for the two launches: ${count} (expected 1)`);
    console.log(`final status: ${row?.status ?? "never seen"}; result: ${JSON.stringify(result?.text ?? null)}`);
    return count === 1 && row?.status === "completed" && result?.text ? 0 : 1;
  } finally {
    link.close();
  }
}

function usage(message: string): number {
  console.error(
    `${message}\nusage: contract-check (--local <root> | --ref <gitRef> [--repo <dir>] | --github <ref>)\n` +
      "       contract-check --live [--record <file>]   (CC_HOME)\n" +
      "       contract-check --probe <apiUrl> --project <id> --i-know-this-launches [--record <file>]   (token on stdin)",
  );
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args) return usage("bad arguments");
  if (args.probe !== undefined) {
    if (typeof args.probe !== "string" || typeof args.project !== "string") return usage("--probe needs <apiUrl> and --project");
    if (!args["i-know-this-launches"]) return usage("--probe launches a real thread; pass --i-know-this-launches");
    return runProbe(args.probe, args.project, recorder(args.record as string | undefined));
  }
  if (args.live) return runLive(recorder(args.record as string | undefined));
  if (args.record) return usage("--record needs --live or --probe");
  const read = reader(args);
  return read ? runStatic(read) : usage("choose a mode");
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`contract-check failed: ${(error as Error).message}`);
      process.exit(1);
    },
  );
}
