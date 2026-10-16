import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main, serve } from "./main.ts";
import type { LaunchInput, LinkEvents, LinkState, Machine, T3Link } from "./types.ts";

const SENTINEL = "SENTINEL-T3-TOKEN-7f3a9c";
const PUBLIC = "https://cc.tailnet.ts.net:8443";
const HOST = "cc.tailnet.ts.net:8443";
const ENV_ID = "env-vps";

function fakeFactory() {
  const made: { machine: Machine; token: string; closed: boolean; launches: LaunchInput[] }[] = [];
  let onLaunch: (input: LaunchInput) => void = () => {};
  const factory = (machine: Machine, token: string, events: LinkEvents): T3Link => {
    const rec = { machine, token, closed: false, launches: [] as LaunchInput[] };
    made.push(rec);
    const state: LinkState = { status: "online", since: new Date().toISOString(), degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: "0.9.0", message: null };
    queueMicrotask(() => {
      events.onState(machine.id, state);
      events.onShell(machine.id, {
        authoritative: true,
        threads: [],
        projects: [
          { machineId: machine.id, id: "p1", title: "Repo", workspaceRoot: "/srv/repo", defaultModel: { instanceId: "codex", model: "gpt-5" }, updatedAt: new Date().toISOString() },
        ],
      });
    });
    return {
      machineId: machine.id,
      state,
      async launch(input) {
        rec.launches.push(input);
        onLaunch(input);
      },
      async interrupt() {},
      async respond() {},
      async settle() {},
      async providers() {
        return [];
      },
      async readResult() {
        return { text: null, pending: null };
      },
      async session() {
        return { expiresAt: "2027-10-15T00:00:00.000Z", scopes: [] };
      },
      close() {
        rec.closed = true;
      },
    };
  };
  return { factory, made, nextLaunch: () => new Promise<LaunchInput>((ok) => (onLaunch = ok)) };
}

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((ok, ko) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: HOST, ...headers, ...(body ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", ko);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Reads SSE until the first data frame, then disconnects. */
function firstFrame(port: number, cookie: string): Promise<string> {
  return new Promise((ok, ko) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: HOST, cookie } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        text += c;
        if (text.includes("\n\n")) {
          req.destroy();
          ok(text);
        }
      });
    });
    req.on("error", (e) => (e.message.includes("aborted") || e.message.includes("socket hang up") ? undefined : ko(e)));
    req.end();
  });
}

test("CLI + serve: pairing, view, task dispatch, re-add, and no token leaks", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "cc-main-"));
  const staticDir = join(home, "dist");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html>");
  const env = { CC_HOME: home, CC_PORT: "0", CC_PUBLIC_URL: `${PUBLIC}/` };

  // Capture everything written to stdout/stderr while the test runs.
  let captured = "";
  const writes = [process.stdout.write, process.stderr.write] as const;
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      captured += String(chunk);
      return orig(chunk, ...rest);
    }) as typeof stream.write;
  }
  const out: string[] = [];
  const cli = (argv: string[], stdin = "") =>
    main(argv, {
      env,
      out: (line) => out.push(line),
      stdin: async () => stdin,
      fetch: (async (url: URL) => {
        assert.equal(url.href, "https://vps.tailnet.ts.net/.well-known/t3/environment");
        return Response.json({ environmentId: ENV_ID, label: "VPS", serverVersion: "0.9.0", orchestrationProtocolVersion: 2 });
      }) as typeof fetch,
    });

  const fake = fakeFactory();
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  t.after(async () => {
    [process.stdout.write, process.stderr.write] = writes;
    await handle?.close();
    rmSync(home, { recursive: true, force: true });
  });

  assert.equal(await cli(["machine", "add", "https://vps.tailnet.ts.net/some/path", "--max", "3", "--label", "Box"], `${SENTINEL}\n`), 0);
  await assert.rejects(cli(["machine", "add", "https://vps.tailnet.ts.net"], "  \n"), /no token/);

  handle = await serve({ home, port: 0, publicUrl: PUBLIC, staticDir }, fake.factory);
  const { port } = handle;
  assert.equal(fake.made.length, 1);
  assert.equal(fake.made[0]!.token, SENTINEL);
  assert.equal(fake.made[0]!.machine.maxConcurrent, 3);
  assert.equal(fake.made[0]!.machine.apiUrl, "https://vps.tailnet.ts.net");

  const bodies: string[] = [];
  const hit = async (...args: Parameters<typeof call>) => {
    const res = await call(...args);
    bodies.push(res.text);
    return res;
  };

  const health = await hit(port, "GET", "/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.text), { ok: true, activeRuns: { [ENV_ID]: 0 } });

  assert.equal((await hit(port, "GET", "/api/view")).status, 401);

  assert.equal(await cli(["pair"]), 0);
  const link = out.find((l) => l.startsWith(`${PUBLIC}/pair#token=`));
  assert.ok(link, "pair prints the link with CC_PUBLIC_URL's origin");
  const pairToken = link.split("#token=")[1]!;
  const paired = await hit(port, "POST", "/api/pair", { origin: PUBLIC }, { token: pairToken });
  assert.equal(paired.status, 200);
  const cookie = String(paired.headers["set-cookie"]).split(";")[0]!;
  const auth = { cookie, origin: PUBLIC };

  const viewRes = await hit(port, "GET", "/api/view", auth);
  assert.equal(viewRes.status, 200);
  const view = JSON.parse(viewRes.text);
  assert.equal(view.machines[0].id, ENV_ID);
  assert.equal(view.machines[0].link.status, "online");

  const projects = JSON.parse((await hit(port, "GET", "/api/projects", auth)).text);
  assert.deepEqual(projects.map((p: { machineId: string; projects: { id: string }[] }) => [p.machineId, p.projects.map((x) => x.id)]), [[ENV_ID, ["p1"]]]);

  const launched = fake.nextLaunch();
  const created = await hit(port, "POST", "/api/tasks", auth, { prompt: "Fix the build", machineId: ENV_ID, projectId: "p1" });
  assert.equal(created.status, 200);
  const taskId = JSON.parse(created.text).id as string;
  const input = await launched;
  assert.equal(input.prompt, "Fix the build");
  assert.deepEqual(input.modelSelection, { instanceId: "codex", model: "gpt-5" });
  assert.equal(JSON.parse((await hit(port, "GET", `/api/tasks/${taskId}`, auth)).text).status, "starting");

  assert.equal((await hit(port, "POST", "/api/tasks", auth, { prompt: "x", machineId: ENV_ID, projectId: "nope" })).status, 400);
  assert.equal((await hit(port, "GET", "/api/tasks/missing", auth)).status, 404);
  assert.equal((await hit(port, "PATCH", `/api/tasks/${taskId}`, auth, { priority: 9 })).status, 400);
  assert.equal((await hit(port, "POST", `/api/tasks/${taskId}/approve`, auth)).status, 409);
  assert.equal((await hit(port, "GET", `/api/machines/${ENV_ID}/providers`, auth)).status, 200);

  const machines = await hit(port, "GET", "/api/machines", auth);
  assert.equal(JSON.parse(machines.text)[0].tokenExpiresAt, "2027-10-15T00:00:00.000Z");

  assert.equal((await hit(port, "GET", `/api/threads/${ENV_ID}/nope`, auth)).status, 404);

  // Agents: a bearer works on /mcp only, cookie routes refuse it, and /mcp refuses a cookie.
  assert.equal(await cli(["agent-token", "add", "hermes"]), 0);
  const agentToken = out.find((l) => l.startsWith("cc_"));
  assert.ok(agentToken, "agent-token add prints the token once");
  const bearer = { authorization: `Bearer ${agentToken}` };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  const mcpRes = await hit(port, "POST", "/mcp", bearer, init);
  assert.equal(mcpRes.status, 200);
  assert.equal(JSON.parse(mcpRes.text).result.serverInfo.name, "t3-command-center");
  const tools = JSON.parse((await hit(port, "POST", "/mcp", bearer, { jsonrpc: "2.0", id: 2, method: "tools/list" })).text).result.tools as { name: string }[];
  for (const name of ["memory_save", "section_list", "agent_profile_save", "artifact_save", "workflow_run"]) assert.ok(tools.some((x) => x.name === name), name);
  assert.equal((await hit(port, "POST", "/mcp", auth, init)).status, 401);
  assert.equal((await hit(port, "GET", "/api/view", bearer)).status, 401);
  assert.equal((await hit(port, "GET", "/api/push/key", bearer)).status, 401);
  const pushKey = await hit(port, "GET", "/api/push/key", auth);
  assert.equal(pushKey.status, 200);
  assert.match(JSON.parse(pushKey.text).key, /^[\w-]{80,}$/);
  await cli(["agent-token", "list"]);
  assert.ok(out.some((l) => l.startsWith("hermes  created=")));
  assert.equal(await cli(["agent-token", "rm", "hermes"]), 0);
  assert.equal((await hit(port, "POST", "/mcp", bearer, init)).status, 401, "a revoked token stops working");

  // Phase 3 routes are all behind the cookie, and a profile's role prompt reaches the launched task.
  for (const path of ["/api/memory/list", "/api/sections", "/api/profiles", "/api/settings/projects", "/api/work", "/api/infra", "/api/finance", "/api/workflows", "/api/workflow-runs", "/api/workflow-needs", "/api/organize/coordinators"])
    assert.equal((await hit(port, path === "/api/memory/list" ? "POST" : "GET", path, {}, path === "/api/memory/list" ? {} : undefined)).status, 401, path);
  const saved = await hit(port, "PUT", "/api/settings/projects", auth, { pinned: [`${ENV_ID}:p1`] });
  assert.equal(saved.status, 200);
  assert.deepEqual(JSON.parse((await hit(port, "GET", "/api/settings/projects", auth)).text).pinned, [`${ENV_ID}:p1`]);
  assert.equal((await hit(port, "GET", "/api/sections", auth)).status, 200);
  assert.equal((await hit(port, "GET", "/api/work", auth)).status, 200);
  // Phase 4: workflows, artifacts and "Ordenar con IA" are wired.
  assert.equal((await hit(port, "POST", "/api/artifacts/list", {}, {})).status, 401);
  assert.deepEqual(JSON.parse((await hit(port, "GET", "/api/workflows", auth)).text), []);
  assert.equal((await hit(port, "GET", "/api/workflow-runs", auth)).status, 200);
  assert.equal((await hit(port, "POST", "/api/artifacts/list", auth, {})).status, 200);
  assert.equal((await hit(port, "GET", "/api/features", auth)).status, 404);
  assert.equal((await hit(port, "POST", "/api/organize", auth, { text: "", coordinator: "claude" })).status, 400);
  const profile = JSON.parse((await hit(port, "POST", "/api/profiles", auth, { name: "Reviewer", rolePrompt: "You review." })).text) as { id: string };
  const withProfile = await hit(port, "POST", "/api/tasks", auth, { prompt: "Check it", machineId: ENV_ID, projectId: "p1", profileId: profile.id });
  assert.equal(withProfile.status, 200);
  assert.equal(JSON.parse(withProfile.text).prompt, "You review.\n\nCheck it");
  assert.equal((await hit(port, "POST", "/api/tasks", auth, { prompt: "x", machineId: ENV_ID, projectId: "p1", profileId: "nope" })).status, 400);

  const frame = await firstFrame(port, cookie);
  bodies.push(frame);
  assert.match(frame, /^data: \{"machines":/);

  // Re-add with a new token: the next reconcile replaces the link (this is how unauthorized clears).
  assert.equal(await cli(["machine", "add", "https://vps.tailnet.ts.net"], "second-token"), 0);
  handle.reconcile();
  assert.equal(fake.made.length, 2);
  assert.equal(fake.made[0]!.closed, true);
  assert.equal(fake.made[1]!.token, "second-token");
  assert.equal(fake.made[1]!.machine.maxConcurrent, 3, "re-add keeps --max");
  assert.equal(fake.made[1]!.machine.label, "Box", "re-add keeps --label");

  await cli(["machine", "list"]);
  assert.ok(out.some((l) => l.startsWith(`${ENV_ID}  Box  https://vps.tailnet.ts.net`) && l.includes("token ok")));
  assert.equal(await cli(["machine", "rm", ENV_ID]), 0);
  assert.equal(existsSync(join(home, "tokens", ENV_ID)), false);
  handle.reconcile();
  assert.equal(fake.made[1]!.closed, true);

  assert.match(captured, /\[cc\] listening on 127\.0\.0\.1:/, "capture works");
  for (const text of [...bodies, ...out, captured]) assert.ok(!text.includes(SENTINEL), "the T3 token leaked");
  for (const text of [...bodies, captured]) assert.ok(!text.includes(agentToken), "the agent token leaked");
});
