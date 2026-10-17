import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ctx } from "./http.ts";
import { createProjectDiscovery, type DiscoveryResult } from "./projectDiscovery.ts";
import type { FileLink } from "./t3link.ts";
import type { ProjectRow, T3Link } from "./types.ts";

type Entry = Awaited<ReturnType<FileLink["listEntries"]>>[number];
const dir = (path: string): Entry => ({ path, kind: "directory" });
const file = (path: string): Entry => ({ path, kind: "file" });
function setup(entries: (cwd: string) => Promise<Entry[]>, projects: ProjectRow[] = []) {
  const calls: { cwd: string; directory: string }[] = [];
  const link: T3Link & Pick<FileLink, "listEntries"> = {
    machineId: "vps", state: { status: "online", since: "", degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: "1", message: null },
    async launch() { assert.fail("discovery cannot launch work"); }, async interrupt() {}, async respond() {}, async settle() {}, close() {},
    async providers() { return []; }, async readResult() { return { text: null, pending: null }; }, async session() { return { expiresAt: null, scopes: [] }; },
    async listEntries(cwd, directory) { calls.push({ cwd, directory }); return entries(cwd); },
  };
  const service = createProjectDiscovery({ projects: () => projects, link: (id) => id === "vps" ? link : undefined });
  const route = service.routes[0]!;
  const run = async (body: unknown) => await route.handler({ body } as Ctx) as DiscoveryResult;
  return { run, calls, link, route };
}

test("discovery requires an explicit absolute root and an online selected machine", async () => {
  const f = setup(async () => []);
  assert.equal(f.route.auth, "cookie");
  for (const root of ["", "repo", "C:repo", "/repo/../other", "D:\\repo\\..\\other", "/repo\0secret", "/" + "a".repeat(501)]) {
    await assert.rejects(f.run({ machineId: "vps", root }), /absoluta/);
  }
  assert.deepEqual(f.calls, []);
  f.link.state.status = "offline";
  await assert.rejects(f.run({ machineId: "vps", root: "/repo" }), /línea/);
  await assert.rejects(f.run({ machineId: "pc", root: "/repo" }), /línea/);
  assert.deepEqual(f.calls, []);
});

test("discovery lists only forty immediate nonhidden directories in batches of four", async () => {
  let active = 0;
  let peak = 0;
  const f = setup(async (cwd) => {
    if (cwd === "/repos") return [dir(".hidden"), file("README.md"), dir("../escape"), ...Array.from({ length: 45 }, (_, n) => dir(`p${n}`))];
    active++; peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return [dir(".git"), dir("nested")];
  });
  const result = await f.run({ machineId: "vps", root: "/repos" });
  assert.equal(result.projects.length, 40);
  assert.equal(result.hasMore, true);
  assert.equal(f.calls.length, 41);
  assert.equal(peak, 4);
  assert.ok(f.calls.every((call) => call.directory === ""));
  assert.ok(f.calls.slice(1).every((call) => /^\/repos\/p\d+$/.test(call.cwd)));
});

test("manifest or git identifies candidates, README alone does not; paths match within the selected machine", async () => {
  const projects: ProjectRow[] = [
    { machineId: "vps", id: "registered", title: "Proyecto conocido", workspaceRoot: "d:\\REPOS\\known\\", defaultModel: null, updatedAt: "" },
    { machineId: "pc", id: "other", title: "No pertenece al VPS", workspaceRoot: "D:\\Repos\\fresh", defaultModel: null, updatedAt: "" },
  ];
  const f = setup(async (cwd) => cwd === "D:\\Repos" ? [dir("known"), dir("fresh"), dir("notes"), dir("python")] : cwd.endsWith("known") ? [file(".git"), file("PRD.md")] : cwd.endsWith("fresh") ? [file("package.json"), file("README.md")] : cwd.endsWith("python") ? [file("pyproject.toml")] : [file("README.md")], projects);
  const result = await f.run({ machineId: "vps", root: "D:\\Repos" });
  assert.deepEqual(result.projects.map((project) => [project.title, project.registered]), [["Proyecto conocido", true], ["fresh", false], ["python", false]]);
  assert.deepEqual(result.projects[0]?.evidence, [".git", "PRD.md"]);
  assert.deepEqual(result.projects[1]?.evidence, ["package.json", "README.md"]);
  assert.equal(result.hasMore, false);
});

test("an unreadable child is reported without dropping other candidates", async () => {
  const f = setup(async (cwd) => {
    if (cwd === "/repos") return [dir("broken"), dir("valid")];
    if (cwd.endsWith("broken")) throw new Error("Acceso denegado");
    return [file("Cargo.toml")];
  });
  const result = await f.run({ machineId: "vps", root: "/repos" });
  assert.deepEqual(result.errors, [{ path: "/repos/broken", message: "Acceso denegado" }]);
  assert.equal(result.projects[0]?.path, "/repos/valid");
});
