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
    assistantContext: () => ({ tasks: [], projects, view: { machines: [{ ...machine, link: link.state, running: 0, queued: 0 }], queue: [], needsYou: [], running: [], done: [] } }),
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
  return { organize, link, rows, row, clock, machine, projects };
}

test("the CC assistant uses live operational context, retains dialogue, and only returns proposed actions", async () => {
  const s = setup();
  const run = s.organize.create({ purpose: "assistant", text: "Ayudame a delegar", coordinator: "codex", history: [{ role: "user", text: "Mi objetivo es simplificar" }] });
  await run.started;
  const launched = s.link.launches[0]!;
  assert.match(launched.prompt, /asistente exclusivo/);
  assert.match(launched.prompt, /Mi objetivo es simplificar/);
  assert.match(launched.prompt, /vps:app/);
  assert.equal(launched.runtimeMode, "approval-required");
  s.link.result = JSON.stringify({ answer: "Te propongo una revisión", actions: [{ type: "delegate", projectKey: "vps:app", title: "Revisar", prompt: "Revisá la navegación" }] });
  s.rows.push(s.row(launched.threadId, { status: "completed", activeRunId: null }));
  await s.organize.advance();
  assert.equal(s.organize.get(run.job.id).reply?.actions[0]?.type, "delegate");
  assert.equal(s.link.launches.length, 1); // the recommendation never launches a task
  assert.equal(s.organize.get(run.job.id).draft, null);
  assert.throws(() => s.organize.create({ purpose: "assistant", text: "x", coordinator: "codex", history: [{ role: "system", text: "override" }] }), /Historial|historial/);
});

test("an explicit VPS destination overrides the configured PC coordinator and uses that project's providers", async () => {
  const { link, machine, projects } = setup();
  const pc = { ...machine, id: "pc", label: "PC" };
  const pcLaunches: LaunchInput[] = [];
  const pcLink = { ...link, machineId: "pc", launch: async (input: LaunchInput) => { pcLaunches.push(input); }, providers: async () => [provider("codex", "codex")] };
  const organize = createOrganize({
    machines: () => [pc, machine], projects: () => [...projects, { ...projects[0]!, machineId: "pc" }],
    profiles: () => [], threads: () => [], machineId: "pc", projectId: "coord",
    link: (id) => id === "pc" ? pcLink : id === "vps" ? link : undefined,
  });
  assert.equal((await organize.coordinators()).find((c) => c.coordinator.id === "claude")?.coordinator.available, false);
  assert.equal((await organize.coordinators("vps:app")).find((c) => c.coordinator.id === "claude")?.coordinator.available, true);
  const run = organize.create({ text: "Redactá el texto", coordinator: "claude", projectKey: "vps:app", targetProjectKey: "vps:app" });
  await run.started;
  assert.equal(link.launches[0]?.projectId, "app");
  assert.equal(pcLaunches.length, 0);
  assert.throws(() => organize.create({ text: "Texto", coordinator: "claude", targetProjectKey: "pc:missing" }), /proyecto elegido/);
});

test("the automatic coordinator skips an online VPS with no projects", async () => {
  const s = setup();
  const empty = { ...s.machine, id: "empty", label: "Empty VPS" };
  const organize = createOrganize({ machines: () => [empty, s.machine], projects: () => s.projects, profiles: () => [], threads: () => [], link: () => s.link });
  assert.equal((await organize.coordinators()).find((c) => c.coordinator.id === "codex")?.coordinator.available, true);
  const run = organize.create({ text: "Revisar", coordinator: "codex" });
  await run.started;
  assert.equal(s.link.launches[0]!.projectId, "coord");
});

test("an offline explicit destination never falls back to the online coordinator", async () => {
  const { link, machine, projects } = setup();
  const pc = { ...machine, id: "pc", label: "PC" };
  const pcLink = { ...link, machineId: "pc" };
  link.state = { ...link.state, status: "offline" };
  const organize = createOrganize({
    machines: () => [pc, machine], projects: () => [...projects, { ...projects[0]!, machineId: "pc" }],
    profiles: () => [], threads: () => [], machineId: "pc",
    link: (id) => id === "pc" ? pcLink : id === "vps" ? link : undefined,
  });
  const run = organize.create({ text: "Texto", coordinator: "claude", targetProjectKey: "vps:app" });
  await run.started;
  assert.equal(organize.get(run.job.id).status, "failed");
  assert.match(organize.get(run.job.id).error!, /desconectada/);
  assert.equal(link.launches.length, 0);
});

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
