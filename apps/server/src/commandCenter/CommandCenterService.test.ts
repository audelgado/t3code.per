import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandCenterAgentId,
  CommandCenterMemoryId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CommandCenterMemoryKind,
  type CommandCenterRecord,
  type CommandCenterStreamEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../processRunner.ts";
import * as CommandCenterService from "./CommandCenterService.ts";
import { layerTest } from "./CommandCenterService.testkit.ts";
import { ONBOARDING_LEAD_ID, ONBOARDING_TEAM_ID } from "./onboarding.ts";

const testLayer = layerTest();

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const section = (name: string) =>
  ({
    entity: "section",
    value: {
      projectId: projectA,
      name,
      status: "in_progress",
      tasksDone: 1,
      tasksTotal: 4,
      dueDate: "2026-11-01",
      trying: "Wire the checkout",
      blocker: null,
      missing: ["Stripe keys", "Copy review"],
      sortKey: 0,
    },
  }) as const;

const memory = (
  kind: CommandCenterMemoryKind,
  text: string,
  projectId: ProjectId | null = projectA,
) =>
  ({
    entity: "memory",
    value: {
      projectId,
      sectionId: null,
      threadId: null,
      kind,
      text,
      done: false,
      source: "user",
    },
  }) as const;

const asMemory = (record: CommandCenterRecord) =>
  record.entity === "memory" ? record.value : assert.fail("expected a memory entry");

it.effect("creates, replaces and removes rows, keeping created time across edits", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const created = yield* service.upsert(section("Checkout"));
    assert.strictEqual(created.entity, "section");
    if (created.entity !== "section") return;
    assert.deepStrictEqual(created.value.missing, ["Stripe keys", "Copy review"]);

    yield* TestClock.adjust("1 minute");
    const updated = yield* service.upsert({
      entity: "section",
      value: { ...section("Checkout v2").value, id: created.value.id, status: "blocked" },
    });
    if (updated.entity !== "section") return assert.fail("expected a section");
    assert.strictEqual(updated.value.createdAt, created.value.createdAt);
    assert.notStrictEqual(updated.value.updatedAt, created.value.updatedAt);
    assert.strictEqual(updated.value.status, "blocked");

    const agent = yield* service.upsert({
      entity: "agentProfile",
      value: {
        name: "Ana",
        avatar: null,
        role: "Frontend",
        rolePrompt: "You build UI.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        teamId: null,
        sortKey: 0,
      },
    });

    const snapshot = yield* service.getSnapshot();
    assert.deepStrictEqual(
      snapshot.sections.map((row) => row.name),
      ["Checkout v2"],
    );
    assert.strictEqual(snapshot.agentProfiles[0]?.modelSelection.model, "gpt-5");

    yield* service.delete({ entity: "section", id: created.value.id });
    yield* service.delete({ entity: "agentProfile", id: agent.value.id });
    const afterDelete = yield* service.getSnapshot();
    assert.strictEqual(afterDelete.sections.length, 0);
    // Agents are archived so assignments that name them still resolve.
    assert.notStrictEqual(afterDelete.agentProfiles[0]?.archivedAt, null);

    if (agent.entity !== "agentProfile") return assert.fail("expected an agent profile");
    const { createdAt: _c, updatedAt: _u, archivedAt: _a, ...editable } = agent.value;
    yield* service.upsert({ entity: "agentProfile", value: editable });
    const restored = yield* service.getSnapshot();
    assert.strictEqual(restored.agentProfiles[0]?.archivedAt, null);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("streams the snapshot first, then each change in order", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const existing = asMemory(yield* service.upsert(memory("todo", "Ship the landing page")));
    const subscribed = yield* Deferred.make<void>();
    const collected = yield* service.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(4),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);

    yield* service.upsert(section("Billing"));
    const done = yield* service.setMemoryDone({ id: existing.id, done: true });
    assert.strictEqual(done.done, true);
    yield* service.delete({ entity: "memory", id: existing.id });

    const events: ReadonlyArray<CommandCenterStreamEvent> = Array.from(
      yield* Fiber.join(collected),
    );
    assert.deepStrictEqual(
      events.map((event) =>
        event.type === "snapshot"
          ? `snapshot:${event.snapshot.memory.length}`
          : event.type === "upserted"
            ? `upserted:${event.record.entity}`
            : `deleted:${event.entity}`,
      ),
      ["snapshot:1", "upserted:section", "upserted:memory", "deleted:memory"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("recalls the latest progress per project, oldest open todos and recent notes", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    // Same clock tick throughout: insertion order breaks ties.
    yield* service.upsert(memory("progress", "A: started auth"));
    yield* service.upsert(memory("progress", "B: deployed", projectB));
    yield* service.upsert(memory("progress", "A: auth done"));
    const firstTodo = asMemory(yield* service.upsert(memory("todo", "A: write tests")));
    yield* service.upsert(memory("todo", "A: review copy"));
    yield* service.upsert(memory("todo", "B: rotate keys", projectB));
    yield* service.upsert(memory("decision", "A: use Postgres"));
    yield* service.upsert(memory("decision", "A: drop Redis"));
    yield* service.upsert(memory("handoff", "A: backend to frontend"));
    yield* service.upsert(memory("note", "A: unrelated"));
    yield* service.setMemoryDone({ id: firstTodo.id, done: true });

    const projectRecall = yield* service.recallMemory({ projectId: projectA });
    assert.deepStrictEqual(
      projectRecall.progress.map((entry) => entry.text),
      ["A: auth done"],
    );
    assert.deepStrictEqual(
      projectRecall.openTodos.map((entry) => entry.text),
      ["A: review copy"],
    );
    assert.deepStrictEqual(
      projectRecall.decisions.map((entry) => entry.text),
      ["A: drop Redis", "A: use Postgres"],
    );
    assert.deepStrictEqual(
      projectRecall.handoffs.map((entry) => entry.text),
      ["A: backend to frontend"],
    );

    const everything = yield* service.recallMemory({});
    assert.deepStrictEqual(
      everything.progress.map((entry) => entry.text),
      ["A: auth done", "B: deployed"],
    );
    assert.deepStrictEqual(
      everything.openTodos.map((entry) => entry.text),
      ["A: review copy", "B: rotate keys"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects completing a memory entry that does not exist", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const error = yield* service
      .setMemoryDone({ id: CommandCenterMemoryId.make("missing"), done: true })
      .pipe(Effect.flip);
    assert.strictEqual(error.message, "Memory entry not found.");
  }).pipe(Effect.provide(testLayer)),
);

const setClock = (iso: string) =>
  TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

const assignment = (finishedAt: string | null) =>
  ({
    entity: "assignment",
    value: {
      agentId: CommandCenterAgentId.make("agent-1"),
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      projectId: projectA,
      sectionId: null,
      task: "Ship it",
      finishedAt,
    },
  }) as const;

const income = (date: string) =>
  ({
    entity: "income",
    value: {
      concept: "Retainer",
      clientName: "Acme",
      date,
      amountCents: 100_00,
      currency: "USD",
      status: "paid",
    },
  }) as const;

it.effect("caps the snapshot and pages older memory with listMemory", () =>
  Effect.gen(function* () {
    yield* setClock("2026-10-13T12:00:00Z");
    const service = yield* CommandCenterService.CommandCenterService;
    // Oldest of all, but open todos always ride along in the snapshot.
    const oldTodo = asMemory(yield* service.upsert(memory("todo", "Old open todo")));
    // One second apart: paging orders by time, then id, so equal times would not keep insert order.
    for (let index = 0; index < 105; index++) {
      yield* TestClock.adjust("1 second");
      yield* service.upsert(memory("note", `Note ${index}`, index % 2 === 0 ? projectA : projectB));
    }
    for (let index = 0; index < 55; index++) {
      yield* service.upsert(assignment(`2026-10-0${1 + (index % 9)}T00:00:00.000Z`));
    }
    yield* service.upsert(assignment(null));
    yield* service.upsert(income("2025-10-01"));
    yield* service.upsert(income("2025-09-30"));

    const snapshot = yield* service.getSnapshot();
    assert.strictEqual(snapshot.memory.length, 101);
    assert.strictEqual(snapshot.memory[0]?.text, "Note 104");
    assert.isTrue(snapshot.memory.some((entry) => entry.id === oldTodo.id));
    assert.strictEqual(snapshot.assignments.length, 51);
    assert.deepStrictEqual(
      snapshot.income.map((row) => [row.date, row.clientName]),
      [["2025-10-01", "Acme"]],
    );

    const first = yield* service.listMemory({ limit: 60 });
    assert.strictEqual(first.entries.length, 60);
    assert.strictEqual(first.entries[0]?.text, "Note 104");
    assert.isTrue(first.hasMore);
    const second = yield* service.listMemory({ limit: 60, before: first.entries.at(-1)?.id });
    assert.strictEqual(second.entries.length, 46);
    assert.isFalse(second.hasMore);
    assert.strictEqual(second.entries.at(-1)?.id, oldTodo.id);

    const projectBNotes = yield* service.listMemory({ projectId: projectB, kind: "note" });
    assert.strictEqual(projectBNotes.entries.length, 50);
    assert.isTrue(projectBNotes.entries.every((entry) => entry.projectId === projectB));
    const todos = yield* service.listMemory({ kind: "todo" });
    assert.deepStrictEqual(
      todos.entries.map((entry) => entry.id),
      [oldTodo.id],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("prunes old history and writes one zero-token digest per active project", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    yield* setClock("2025-06-01T10:00:00Z");
    const oldDone = asMemory(yield* service.upsert(memory("todo", "Long done")));
    yield* service.setMemoryDone({ id: oldDone.id, done: true });
    const oldAssignment = yield* service.upsert(assignment("2025-09-01T00:00:00.000Z"));

    yield* setClock("2025-12-31T09:00:00Z");
    yield* service.upsert(section("Checkout"));
    yield* service.upsert(memory("todo", "Open one"));
    const closed = asMemory(yield* service.upsert(memory("todo", "Close one")));
    yield* service.setMemoryDone({ id: closed.id, done: true });
    yield* service.upsert(assignment("2025-12-31T10:00:00.000Z"));

    yield* setClock("2026-01-01T03:00:00Z");
    yield* service.runDailyMaintenance();
    yield* service.runDailyMaintenance();

    const snapshot = yield* service.getSnapshot();
    assert.isFalse(snapshot.assignments.some((row) => row.id === oldAssignment.value.id));
    assert.isFalse(snapshot.memory.some((entry) => entry.id === oldDone.id));
    const digests = snapshot.memory.filter((entry) => entry.source === "system");
    assert.deepStrictEqual(
      digests.map((entry) => [entry.projectId, entry.kind, entry.text]),
      [
        [
          projectA,
          "progress",
          "Daily digest 2025-12-31: 1 assignments finished, 1 sections changed, 2 todos opened, 1 todos closed.",
        ],
      ],
    );
    assert.strictEqual(
      (yield* service.recallMemory({ projectId: projectA })).progress[0]?.id,
      digests[0]?.id,
    );

    // Progress someone wrote, even an older one, stays the headline; the digest follows it.
    yield* setClock("2025-12-31T09:00:00Z");
    yield* service.upsert(memory("progress", "A: checkout wired"));
    yield* service.upsert(memory("progress", "B: deployed", projectB));
    const projectRecall = yield* service.recallMemory({ projectId: projectA });
    assert.deepStrictEqual(
      projectRecall.progress.map((entry) => [entry.source, entry.text]),
      [
        ["user", "A: checkout wired"],
        ["system", digests[0]?.text],
      ],
    );
    assert.deepStrictEqual(
      (yield* service.recallMemory({})).progress.map((entry) => entry.text),
      ["B: deployed", "A: checkout wired", digests[0]?.text],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does nothing and refuses the stream while the setting is off", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    yield* setClock("2025-06-01T10:00:00Z");
    yield* service.upsert(assignment("2025-01-01T00:00:00.000Z"));
    yield* setClock("2026-01-01T03:00:00Z");
    yield* service.runDailyMaintenance();
    assert.strictEqual((yield* service.getSnapshot()).assignments.length, 1);

    const error = yield* service.subscribe().pipe(Stream.runCollect, Effect.flip);
    assert.include(error.message, "commandCenter.enabled");
  }).pipe(Effect.provide(layerTest({ enabled: false }))),
);

it.effect("builds a bounded repo digest from a git checkout and keeps one per project", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cc-digest-" });
    yield* fs.makeDirectory(path.join(root, "src"));
    yield* fs.writeFileString(
      path.join(root, "package.json"),
      JSON.stringify({ name: "demo", scripts: { dev: "vite", test: "vitest" } }),
    );
    yield* fs.writeFileString(path.join(root, "README.md"), "# Demo\n\nText\n\n## Setup\n");
    yield* fs.writeFileString(
      path.join(root, "src", "app.ts"),
      "export const app = 1;\n// TODO: wire auth\n",
    );
    const git = (...args: ReadonlyArray<string>) =>
      runner.run({
        command: "git",
        args: ["-c", "user.name=T3", "-c", "user.email=t3@example.com", ...args],
        cwd: root,
      });
    yield* git("init");
    yield* git("add", ".");
    yield* git("commit", "-m", "Initial commit");

    yield* Effect.gen(function* () {
      const service = yield* CommandCenterService.CommandCenterService;
      const digest = yield* service.buildRepoDigest(projectA);
      assert.strictEqual(digest.kind, "note");
      assert.strictEqual(digest.source, "system");
      assert.isAtMost(digest.text.length, 8_001);
      for (const expected of [
        "Repo digest for",
        "git: yes, new repo: yes",
        "src/ (1)",
        "TypeScript 1",
        "package.json (demo)",
        "dev: vite",
        "# Demo",
        "## Setup",
        "commits: 1",
        "src/app.ts:2:// TODO: wire auth",
      ]) {
        assert.include(digest.text, expected);
      }

      const rebuilt = yield* service.buildRepoDigest(projectA);
      assert.strictEqual(rebuilt.id, digest.id);
      assert.strictEqual((yield* service.getRepoDigest(projectA)).id, digest.id);
      const missing = yield* service.buildRepoDigest(projectB).pipe(Effect.flip);
      assert.strictEqual(missing.message, "Project not found.");
    }).pipe(Effect.provide(layerTest({ projects: { [projectA]: root } })));
  }).pipe(
    // Not layerTest(): layers are memoized per test, so the inner one would be ignored.
    Effect.provide(
      Layer.merge(NodeServices.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  ),
);

it.effect("ensures the Onboarding team once and keeps the user's edits", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const first = yield* service.ensureOnboardingTeam();
    assert.strictEqual(first.team.id, ONBOARDING_TEAM_ID);
    assert.deepStrictEqual(
      first.agents.map((agent) => agent.name),
      ["Lead", "Scout", "Organizer"],
    );
    const lead = first.agents[0];
    assert(lead !== undefined && lead.id === ONBOARDING_LEAD_ID);
    assert.include(lead.rolePrompt, "delegate_task");

    const { createdAt: _c, updatedAt: _u, archivedAt: _a, ...editable } = lead;
    yield* service.upsert({
      entity: "agentProfile",
      value: { ...editable, rolePrompt: "My own onboarding flow." },
    });
    yield* service.delete({ entity: "team", id: ONBOARDING_TEAM_ID });

    const second = yield* service.ensureOnboardingTeam();
    assert.strictEqual(second.team.archivedAt, null);
    assert.strictEqual(second.agents[0]?.rolePrompt, "My own onboarding flow.");
    const snapshot = yield* service.getSnapshot();
    assert.strictEqual(snapshot.teams.length, 1);
    assert.strictEqual(snapshot.agentProfiles.length, 3);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("clips recalled text and pages on from a cursor entry deleted meanwhile", () =>
  Effect.gen(function* () {
    yield* setClock("2026-10-13T12:00:00Z");
    const service = yield* CommandCenterService.CommandCenterService;
    yield* service.upsert(memory("progress", "x".repeat(2_000)));
    const recalled = yield* service.recallMemory({ projectId: projectA });
    const text = recalled.progress[0]?.text ?? "";
    assert.isTrue(text.length <= 601 && text.length > 100);

    const older = asMemory(yield* service.upsert(memory("note", "Older")));
    yield* setClock("2026-10-13T12:00:01Z");
    const cursor = asMemory(yield* service.upsert(memory("note", "Cursor")));
    yield* setClock("2026-10-13T12:00:02Z");
    yield* service.upsert(memory("note", "Newer"));
    yield* service.delete({ entity: "memory", id: cursor.id });
    const page = yield* service.listMemory({
      before: cursor.id,
      beforeCreatedAt: cursor.createdAt,
      kind: "note",
    });
    assert.deepStrictEqual(
      page.entries.map((entry) => entry.id),
      [older.id],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("keeps one open assignment per agent and releases it when the agent is archived", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const agent = yield* service.upsert({
      entity: "agentProfile",
      value: {
        name: "Ana",
        avatar: null,
        role: "Frontend",
        rolePrompt: "",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        teamId: null,
        sortKey: 0,
      },
    });
    const open = (threadId: string) =>
      service.upsert({
        entity: "assignment",
        value: {
          ...assignment(null).value,
          agentId: CommandCenterAgentId.make(agent.value.id),
          threadId: ThreadId.make(threadId),
        },
      });
    yield* open("thread-a");
    yield* TestClock.adjust("1 second");
    yield* open("thread-b");
    const openThreads = (yield* service.getSnapshot()).assignments
      .filter((row) => row.finishedAt === null)
      .map((row) => row.threadId);
    assert.deepStrictEqual(openThreads, ["thread-b"]);

    yield* service.delete({ entity: "agentProfile", id: agent.value.id });
    const after = yield* service.getSnapshot();
    assert.isTrue(after.assignments.every((row) => row.finishedAt !== null));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("treats section names that differ only in case or Unicode form as one", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const { value } = section("Diseño");
    const first = yield* service.createSection(value);
    // "DISEÑO" is the decomposed, upper-case spelling of the same name.
    const second = yield* service.createSection({ ...value, name: "DISEÑO" });
    assert.strictEqual(second.id, first.id);
    assert.strictEqual((yield* service.listSections(projectA)).sections.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("links a section's pull request, keeps it across edits and clears it", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const { value } = section("Checkout");
    const created = yield* service.createSection(value);
    const prUrl = "https://github.com/acme/shop/pull/42";
    const linked = yield* service.setSectionPullRequest({ id: created.id, prUrl, prNumber: 42 });
    assert.deepInclude(linked, { prUrl, prNumber: 42 });
    yield* service.upsert({ entity: "section", value: { ...value, id: created.id, tasksDone: 2 } });
    const [kept] = (yield* service.listSections(projectA)).sections;
    assert.deepInclude(kept, { prUrl, prNumber: 42, tasksDone: 2 });
    // Clearing the URL clears the number with it.
    const cleared = yield* service.setSectionPullRequest({
      id: created.id,
      prUrl: null,
      prNumber: 42,
    });
    assert.deepInclude(cleared, { prUrl: null, prNumber: null });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("serves a summary subscription without memory or money", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    yield* service.upsert(memory("note", "Private"));
    yield* service.upsert(income("2026-10-01"));
    yield* service.upsert(section("Checkout"));
    const [first] = yield* service
      .subscribe({ scope: "summary" })
      .pipe(Stream.take(1), Stream.runCollect);
    if (first?.type !== "snapshot") return assert.fail("expected a snapshot");
    assert.strictEqual(first.snapshot.memory.length, 0);
    assert.strictEqual(first.snapshot.income.length, 0);
    assert.strictEqual(first.snapshot.sections.length, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("lets agents in only where Command Center is kept", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    const refused = yield* service.checkAgentAccess().pipe(Effect.flip);
    assert.include(refused.message, "not set up");
    // A summary view (mobile) does not make this machine the home; opening it fully does.
    yield* service.subscribe({ scope: "summary" }).pipe(Stream.take(1), Stream.runDrain);
    yield* service.checkAgentAccess().pipe(Effect.flip);
    yield* service.subscribe().pipe(Stream.take(1), Stream.runDrain);
    yield* service.checkAgentAccess();
  }).pipe(Effect.provide(layerTest({ home: false }))),
);

it.effect("refuses agents and skips the daily tick while the setting is off", () =>
  Effect.gen(function* () {
    const service = yield* CommandCenterService.CommandCenterService;
    assert.isFalse(yield* service.runDailyMaintenance());
    const refused = yield* service.checkAgentAccess().pipe(Effect.flip);
    assert.include(refused.message, "turned off");
  }).pipe(Effect.provide(layerTest({ enabled: false }))),
);
