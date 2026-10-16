import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrganize, parseDraft } from "./organize.ts";
import type { LaunchInput, LinkState, Machine, ProjectRow, ProviderInfo, T3Link, ThreadRow } from "./types.ts";

const T0 = Date.parse("2026-10-15T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const provider = (instanceId: string, driver: string, displayName = driver): ProviderInfo => ({
  instanceId,
  driver,
  displayName,
  enabled: true,
  installed: true,
  models: [{ slug: `${instanceId}-model`, name: "M", isDefault: true }],
});

function setup(providers: ProviderInfo[] = [provider("claudeAgent", "claudeAgent", "Claude"), provider("codex", "codex")]) {
  const clock = { now: T0 };
  const rows: ThreadRow[] = [];
  const link = {
    machineId: "vps",
    state: { status: "online", since: iso(T0), degraded: false, droppedRows: 0, unknownItems: 0, serverVersion: "1", message: null } as LinkState,
    launches: [] as LaunchInput[],
    interrupts: [] as [string, string][],
    settled: [] as string[],
    result: null as string | null,
    async launch(input: LaunchInput) {
      link.launches.push(input);
    },
    async interrupt(threadId: string, runId: string) {
      link.interrupts.push([threadId, runId]);
    },
    async respond() {
      throw new Error("the coordinator never approves anything");
    },
    async settle(threadId: string) {
      link.settled.push(threadId);
    },
    async providers() {
      return providers;
    },
    async readResult() {
      return { text: link.result, pending: null };
    },
    async session() {
      return { expiresAt: null, scopes: [] };
    },
    close() {},
  };
  link satisfies T3Link;
  const machine: Machine = { id: "vps", label: "VPS", apiUrl: "https://vps", webUrl: null, maxConcurrent: 2, enabled: true, serverVersion: null, tokenExpiresAt: null, createdAt: iso(T0) };
  const projects: ProjectRow[] = ["coord", "app"].map((id) => ({ machineId: "vps", id, title: id, workspaceRoot: `/srv/${id}`, defaultModel: null, updatedAt: iso(T0) }));
  let n = 0;
  const organize = createOrganize({
    machines: () => [machine],
    projects: () => projects,
    profiles: () => [{ id: "rev", name: "Reviewer", rolePrompt: "You review." }],
    link: (id) => (id === "vps" ? link : undefined),
    threads: () => rows,
    now: () => clock.now,
    newId: () => `id${++n}`,
    timeoutMs: 120_000,
  });
  const row = (threadId: string, patch: Partial<ThreadRow>): ThreadRow => ({
    machineId: "vps",
    id: threadId,
    projectId: "coord",
    title: "t",
    status: "running",
    activityRunStatus: "running",
    activeRunId: "run1",
    pendingRequest: null,
    hasActionableProposedPlan: false,
    lastError: null,
    usageLimitResetAt: null,
    relationshipToParent: null,
    snoozedUntil: null,
    settledAt: null,
    providerInstanceId: "claudeAgent",
    completedAt: null,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...patch,
  });
  return { organize, link, rows, row, clock };
}

const known = { projectKeys: new Set(["vps:app"]), profileIds: new Set(["rev"]), hint: null };

test("coordinators map providers of the coordinator machine; hermes missing has a reason", async () => {
  const { organize } = setup();
  const list = (await organize.coordinators()).map((c) => c.coordinator);
  assert.deepEqual(
    list.map((c) => [c.id, c.available]),
    [
      ["claude", true],
      ["codex", true],
      ["hermes", false],
    ],
  );
  assert.equal(list[2]!.reason, "Hermes no está configurado como proveedor ACP en la VPS");

  const withHermes = setup([{ ...provider("acp-1", "acp", "Hermes (Local ACP command)") }, { ...provider("codex", "codex"), installed: false }]);
  const states = (await withHermes.organize.coordinators()).map((c) => c.coordinator.available);
  assert.deepEqual(states, [false, false, true]);
});

test("parseDraft tolerates fences and surrounding text, then clamps", () => {
  const text = [
    "Acá va:",
    "```json",
    JSON.stringify({
      title: "x".repeat(100),
      prompt: " Hacé la cosa ",
      projectKey: "vps:nope",
      priority: 7,
      profileId: "ghost",
      steps: [{ title: "Uno", prompt: "a" }],
      questions: ["1", "2", "3", "4", "5", "6", 7],
    }),
    "```",
  ].join("\n");
  const draft = parseDraft(text, { ...known, hint: "vps:app" })!;
  assert.equal(draft.title.length, 80);
  assert.equal(draft.prompt, "Hacé la cosa");
  assert.equal(draft.projectKey, "vps:app", "an unknown key falls back to the user's hint");
  assert.equal(draft.priority, 2);
  assert.equal(draft.profileId, null);
  assert.deepEqual(draft.steps, [], "a single step stays in prompt");
  assert.deepEqual(draft.questions, ["1", "2", "3", "4", "5"]);

  const steps = Array.from({ length: 15 }, (_, i) => ({ title: `S${i}`, prompt: `p${i}` }));
  const many = parseDraft(JSON.stringify({ prompt: "p", priority: "x", profileId: "rev", projectKey: "vps:app", steps }), known)!;
  assert.equal(many.steps.length, 12);
  assert.equal(many.priority, 0);
  assert.equal(many.profileId, "rev");
  assert.equal(many.title, "p");

  for (const garbage of [null, "", "no json here", "{ broken", '{"title":"sin prompt"}', "[1,2]"]) assert.equal(parseDraft(garbage, known), null);
});

test("a completed thread yields a draft; the thread is settled", async () => {
  const { organize, link, rows, row } = setup();
  assert.equal((await organize.coordinators())[0]!.coordinator.available, true);
  const { job, started } = organize.create({ text: "  arreglá el login  ", coordinator: "claude", projectKey: "vps:app" });
  assert.equal(job.status, "running");
  await started;
  const launch = link.launches[0]!;
  assert.equal(launch.runtimeMode, "approval-required");
  assert.deepEqual(launch.workspaceStrategy, { type: "root" });
  assert.equal(launch.projectId, "coord");
  assert.deepEqual(launch.modelSelection, { instanceId: "claudeAgent", model: "claudeAgent-model" });
  assert.match(launch.prompt, /arreglá el login/);
  assert.match(launch.prompt, /vps:app \| app \| VPS/);
  assert.match(launch.prompt, /rev \| Reviewer \| You review\./);
  assert.equal(organize.owns("vps", launch.threadId), true, "the coordinator thread is plumbing, hidden from the UI");
  assert.equal(organize.owns("vps", "other"), false);

  rows.push(row(launch.threadId, {}));
  await organize.advance();
  assert.equal(organize.get(job.id).status, "running");

  link.result = '```json\n{"title":"Login","prompt":"Arreglá el login.","projectKey":null,"priority":1,"profileId":null,"steps":[],"questions":[]}\n```';
  rows[0] = row(launch.threadId, { status: "completed", activeRunId: null });
  await organize.advance();
  const done = organize.get(job.id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.draft, { title: "Login", prompt: "Arreglá el login.", projectKey: "vps:app", priority: 1, profileId: null, steps: [], questions: [] });
  assert.deepEqual(link.settled, [launch.threadId]);
});

test("a pending approval fails the job and stops the run without approving", async () => {
  const { organize, link, rows, row } = setup();
  const { job, started } = organize.create({ text: "hacé algo", coordinator: "codex" });
  await started;
  const threadId = link.launches[0]!.threadId;
  rows.push(row(threadId, { pendingRequest: { id: "r1", kind: "command", summary: null, createdAt: iso(T0) } }));
  await organize.advance();
  const failed = organize.get(job.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /sin aprobar nada/);
  assert.deepEqual(link.interrupts, [[threadId, "run1"]]);
});

test("a run past the timeout fails", async () => {
  const { organize, link, rows, row, clock } = setup();
  const { job, started } = organize.create({ text: "hacé algo", coordinator: "claude" });
  await started;
  rows.push(row(link.launches[0]!.threadId, {}));
  clock.now += 120_000;
  await organize.advance();
  assert.deepEqual([organize.get(job.id).status, organize.get(job.id).error], ["failed", "El coordinador tardó demasiado"]);
});

test("input is validated and an unavailable coordinator fails with its reason", async () => {
  const { organize, link } = setup();
  assert.throws(() => organize.create({ text: " ", coordinator: "claude" }), /entre 1 y 8000/);
  assert.throws(() => organize.create({ text: "x".repeat(8001), coordinator: "claude" }), /entre 1 y 8000/);
  assert.throws(() => organize.create({ text: "x", coordinator: "gpt" }), /Coordinador desconocido/);
  const { job, started } = organize.create({ text: "x", coordinator: "hermes" });
  await started;
  assert.equal(organize.get(job.id).error, "Hermes no está configurado como proveedor ACP en la VPS");
  assert.equal(link.launches.length, 0);
  assert.throws(() => organize.get("missing"), /No se encontró/);
});
