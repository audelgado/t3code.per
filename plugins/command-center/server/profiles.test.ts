import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mintPairing } from "./auth.ts";
import { openDb, replaceProjects } from "./db.ts";
import { Dispatcher } from "./dispatcher.ts";
import { createServer } from "./http.ts";
import { ToolError } from "./mcp.ts";
import { applyProfile, createProfileRoutes, getProfile, initProfiles, listProfiles, profileTools, resolveProfile, saveProfile } from "./profiles.ts";

const PUBLIC = "https://cc.tailnet.ts.net:8443";
const HOST = "cc.tailnet.ts.net:8443";

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-prof-"));
  const db = openDb(home);
  initProfiles(db);
  initProfiles(db); // idempotent
  replaceProjects(db, "m1", [{ machineId: "m1", id: "p1", title: "App", workspaceRoot: "/srv/app", defaultModel: null, updatedAt: "2026-10-15T00:00:00.000Z" }]);
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { db, home, base: { machineId: "m1", projectId: "p1" } };
}

const reviewer = { name: "Reviewer", avatar: "R", rolePrompt: "You review code.", model: { instanceId: "claude", model: "opus" }, runtimeMode: "approval-required", interactionMode: "plan" } as const;

test("profiles save, update and reject bad input", (t) => {
  const { db } = setup(t);
  const p = saveProfile(db, reviewer, "user");
  assert.deepEqual([p.name, p.model, p.runtimeMode, p.createdBy], ["Reviewer", reviewer.model, "approval-required", "user"]);
  assert.equal(saveProfile(db, { ...reviewer, name: "Senior reviewer" }, "user", p.id).id, p.id);
  assert.deepEqual(listProfiles(db).map((x) => x.name), ["Senior reviewer"]);
  assert.throws(() => saveProfile(db, { name: "" }, "user"), { code: "invalid" });
  assert.throws(() => saveProfile(db, { name: "x", runtimeMode: "root" }, "user"), { code: "invalid" });
  assert.throws(() => saveProfile(db, { name: "x" }, "user", "missing"), { code: "not_found" });
  assert.throws(() => saveProfile(db, { name: "SENIOR REVIEWER" }, "user"), { code: "conflict" });
});

test("applyProfile prefixes the prompt and fills only what the input leaves unset", (t) => {
  const { db, base } = setup(t);
  const p = saveProfile(db, reviewer, "user");
  const out = applyProfile(db, { ...base, prompt: "  check the diff\nplease ", profileId: p.id }, "user");
  assert.equal(out.prompt, "You review code.\n\ncheck the diff\nplease");
  assert.equal(out.title, "check the diff");
  assert.deepEqual([out.model, out.runtimeMode, out.interactionMode], [reviewer.model, "approval-required", "plan"]);
  const own = applyProfile(db, { ...base, prompt: "x", profileId: p.id, runtimeMode: "auto", model: { instanceId: "a", model: "b" } }, "user");
  assert.deepEqual([own.runtimeMode, own.model?.model], ["auto", "b"]);
  const plain = { ...base, prompt: "x" };
  assert.deepEqual(applyProfile(db, plain, "user"), plain);
  assert.throws(() => applyProfile(db, { ...base, prompt: "x", profileId: "nope" }, "user"), { code: "invalid" });
});

test("a profile's runtime mode never applies to agent-sourced tasks", (t) => {
  const { db, base } = setup(t);
  const p = saveProfile(db, reviewer, "user");
  assert.equal(resolveProfile(db, p.id, true).runtimeMode, null);
  assert.equal(resolveProfile(db, p.id, false).runtimeMode, "approval-required");
  assert.equal(applyProfile(db, { ...base, prompt: "x", profileId: p.id }, "agent:hermes").runtimeMode, undefined);
});

test("agent_profile_save: own profiles only, no modes", (t) => {
  const { db } = setup(t);
  saveProfile(db, { name: "Mine" }, "user");
  const [save] = profileTools(db);
  const args = { name: "Docs writer", rolePrompt: "Write docs.", runtimeMode: "full-access", interactionMode: "plan" };
  const { id } = save!.handler(args, "hermes") as { id: string };
  const p = getProfile(db, id)!;
  assert.deepEqual([p.createdBy, p.runtimeMode, p.interactionMode], ["agent:hermes", null, null]);
  assert.equal((save!.handler({ ...args, rolePrompt: "v2" }, "hermes") as { id: string }).id, id);
  assert.equal(getProfile(db, id)!.rolePrompt, "v2");
  assert.throws(() => save!.handler({ ...args, name: "mine" }, "hermes"), ToolError);
  assert.throws(() => save!.handler(args, "codex"), ToolError);
  assert.equal((save!.handler({ id, name: "Docs", role_prompt: "v3" }, "hermes") as { id: string }).id, id);
  assert.deepEqual([getProfile(db, id)!.name, getProfile(db, id)!.rolePrompt], ["Docs", "v3"]);
  assert.throws(() => save!.handler({ name: "Empty" }, "hermes"), /rolePrompt is required/);
});

test("profile and plan routes", async (t) => {
  const { db, home, base } = setup(t);
  const dispatcher = new Dispatcher({ db, link: () => undefined });
  const server: Server = await createServer({ routes: createProfileRoutes({ db, tasks: dispatcher }), publicUrl: PUBLIC, db, staticDir: join(home, "dist"), port: 0 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((ok) => server.close(ok));
  });
  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: any }>((ok, ko) => {
      const r = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, method, path, headers: { host: HOST, "content-type": "application/json", origin: PUBLIC, ...headers } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, json: text ? JSON.parse(text) : undefined }));
      });
      r.on("error", ko);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    });
  assert.equal((await send("GET", "/api/profiles")).status, 401);
  const cookie = String((await send("POST", "/api/pair", { token: mintPairing(db) })).headers["set-cookie"]?.[0]).split(";")[0]!;
  const h = { cookie };

  const made = await send("POST", "/api/profiles", reviewer, h);
  assert.equal(made.status, 200);
  assert.equal((await send("POST", "/api/profiles", reviewer, h)).status, 409);
  assert.equal((await send("POST", "/api/profiles", { name: "" }, h)).status, 400);
  assert.equal((await send("PATCH", "/api/profiles/zzz", { name: "a" }, h)).status, 404);
  assert.equal((await send("PATCH", `/api/profiles/${made.json.id}`, { ...reviewer, name: "Renamed" }, h)).json.name, "Renamed");

  const plan = await send("POST", "/api/plans", { ...base, profileId: made.json.id, steps: [{ prompt: "one" }, { prompt: "two", after: [0] }] }, h);
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.json.map((x: { dependsOn: string[] }) => x.dependsOn.length), [0, 1]);
  assert.equal(plan.json[0].prompt, "You review code.\n\none");
  assert.equal(plan.json[0].title, "one");
  assert.equal((await send("POST", "/api/plans", { ...base, steps: [] }, h)).status, 400);
  assert.equal((await send("POST", "/api/plans", { ...base, profileId: "nope", steps: [{ prompt: "a" }] }, h)).status, 400);
  assert.equal((await send("DELETE", `/api/profiles/${made.json.id}`, undefined, h)).status, 200);
  assert.equal((await send("DELETE", `/api/profiles/${made.json.id}`, undefined, h)).status, 404);
});
