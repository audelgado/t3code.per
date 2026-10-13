import {
  CommandCenterMemoryId,
  CommandCenterSectionId,
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type CommandCenterMemoryEntry,
  type CommandCenterSection,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addDays,
  daysBetween,
  delegationSteps,
  nextDelivery,
  previewThreadFor,
  projectHealth,
  projectProgress,
  pullRequestLinkFromInput,
  recurringProjectTasks,
  stripMarkers,
  unmetDependencies,
  whereWeLeftOff,
} from "./logic";

const PROJECT = ProjectId.make("project");
const OTHER = ProjectId.make("other");
const TODAY = "2026-10-13";

const section = (
  patch: Omit<Partial<CommandCenterSection>, "id"> & { id: string },
): CommandCenterSection => ({
  projectId: PROJECT,
  name: patch.id,
  status: "in_progress",
  tasksDone: 0,
  tasksTotal: 0,
  dueDate: null,
  trying: null,
  blocker: null,
  missing: [],
  dependsOn: [],
  sortKey: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...patch,
  id: CommandCenterSectionId.make(patch.id),
});

const memory = (
  patch: Omit<Partial<CommandCenterMemoryEntry>, "id"> & { id: string; createdAt: string },
): CommandCenterMemoryEntry => ({
  projectId: PROJECT,
  sectionId: null,
  threadId: null,
  kind: "note",
  text: patch.id,
  done: false,
  source: "user",
  updatedAt: patch.createdAt,
  ...patch,
  id: CommandCenterMemoryId.make(patch.id),
});

describe("project dates", () => {
  it("counts calendar days across month ends", () => {
    expect(daysBetween(TODAY, "2026-11-02")).toBe(20);
    expect(daysBetween(TODAY, "2026-10-10")).toBe(-3);
    expect(addDays(TODAY, 35)).toBe("2026-11-17");
  });

  it("picks the earliest open delivery from today on", () => {
    const sections = [
      section({ id: "late", dueDate: "2026-10-12" }),
      section({ id: "shipped", dueDate: "2026-10-14", status: "done" }),
      section({ id: "later", dueDate: "2026-10-20" }),
      section({ id: "soon", dueDate: "2026-10-15" }),
    ];
    expect(nextDelivery(sections, TODAY)).toMatchObject({ section: { name: "soon" }, days: 2 });
  });

  it("places only open sections due inside the window on the strip", () => {
    const markers = stripMarkers(
      [
        section({ id: "today", dueDate: TODAY }),
        section({ id: "edge", dueDate: addDays(TODAY, 35) }),
        section({ id: "beyond", dueDate: addDays(TODAY, 36) }),
        section({ id: "done", dueDate: TODAY, status: "done" }),
      ],
      TODAY,
    );
    expect(markers.map((marker) => [marker.section.name, marker.left])).toEqual([
      ["today", 0],
      ["edge", 100],
    ]);
  });
});

describe("project progress", () => {
  it("sums tasks and never counts more done than total", () => {
    expect(
      projectProgress([
        section({ id: "a", tasksDone: 3, tasksTotal: 4, status: "done" }),
        section({ id: "b", tasksDone: 9, tasksTotal: 4 }),
      ]),
    ).toEqual({ done: 7, total: 8, delivered: 1, percent: 88 });
    expect(projectProgress([]).percent).toBe(0);
  });
});

describe("where we left off", () => {
  it("returns the newest progress entry and open todos oldest first for that project", () => {
    const result = whereWeLeftOff(
      [
        memory({ id: "old", kind: "progress", createdAt: "2026-10-01T00:00:00.000Z" }),
        memory({ id: "new", kind: "progress", createdAt: "2026-10-05T00:00:00.000Z" }),
        memory({
          id: "elsewhere",
          kind: "progress",
          projectId: OTHER,
          createdAt: "2026-10-09T00:00:00.000Z",
        }),
        memory({ id: "todo-2", kind: "todo", createdAt: "2026-10-04T00:00:00.000Z" }),
        memory({ id: "todo-1", kind: "todo", createdAt: "2026-10-02T00:00:00.000Z" }),
        memory({ id: "closed", kind: "todo", done: true, createdAt: "2026-10-03T00:00:00.000Z" }),
      ],
      PROJECT,
    );
    expect(result.progress?.text).toBe("new");
    expect(result.todos.map((todo) => todo.text)).toEqual(["todo-1", "todo-2"]);
  });

  it("keeps agent progress as the headline when a newer daily digest exists", () => {
    const result = whereWeLeftOff(
      [
        memory({
          id: "agent",
          kind: "progress",
          source: "agent",
          createdAt: "2026-10-05T00:00:00.000Z",
        }),
        memory({
          id: "digest-old",
          kind: "progress",
          source: "system",
          createdAt: "2026-10-06T00:00:00.000Z",
        }),
        memory({
          id: "digest",
          kind: "progress",
          source: "system",
          createdAt: "2026-10-07T00:00:00.000Z",
        }),
      ],
      PROJECT,
    );
    expect(result.progress?.text).toBe("agent");
    expect(result.digest?.text).toBe("digest");
  });

  it("builds one step per missing item and open todo, skipping interview questions", () => {
    const checkout = section({ id: "Checkout", missing: ["tests, then copy", "copy"] });
    expect(
      delegationSteps(
        [checkout, section({ id: "Shipped", missing: ["ignored"], status: "done" })],
        [
          memory({ id: "Fix login", kind: "todo", createdAt: "2026-10-02T00:00:00.000Z" }),
          memory({
            id: "Question: who is the client?",
            kind: "todo",
            createdAt: "2026-10-03T00:00:00.000Z",
          }),
        ],
      ),
    ).toEqual([
      { text: "Checkout: tests, then copy", sectionId: checkout.id },
      { text: "Checkout: copy", sectionId: checkout.id },
      { text: "Fix login", sectionId: null },
    ]);
  });
});

describe("dependencies and health", () => {
  it("lists only unfinished dependencies of open sections, across projects", () => {
    const api = section({ id: "api", projectId: OTHER });
    const shipped = section({ id: "shipped", projectId: OTHER, status: "done" });
    const unmet = unmetDependencies([
      section({ id: "ui", dependsOn: [api.id, shipped.id, CommandCenterSectionId.make("gone")] }),
      section({ id: "closed", status: "done", dependsOn: [api.id] }),
      api,
      shipped,
    ]);
    expect([...unmet].map(([id, deps]) => [id, deps.map((dep) => dep.name)])).toEqual([
      ["ui", ["api"]],
    ]);
  });

  it("goes red on overdue, blocked or a 48h delivery under 70%, amber on softer risks", () => {
    const health = (sections: CommandCenterSection[], activeAgents = 1, waitingSections = 0) =>
      projectHealth({ sections, today: TODAY, activeAgents, waitingSections }).level;
    expect(health([section({ id: "fine", dueDate: "2026-11-30" })])).toBe("green");
    expect(health([section({ id: "late", dueDate: "2026-10-12" })])).toBe("red");
    expect(health([section({ id: "stuck", status: "blocked" })])).toBe("red");
    expect(
      health([section({ id: "close", dueDate: "2026-10-15", tasksDone: 6, tasksTotal: 10 })]),
    ).toBe("red");
    expect(
      health([section({ id: "close-ok", dueDate: "2026-10-15", tasksDone: 7, tasksTotal: 10 })]),
    ).toBe("green");
    expect(health([section({ id: "week", dueDate: "2026-10-19" })])).toBe("amber");
    expect(health([section({ id: "idle" })], 0)).toBe("amber");
    expect(health([section({ id: "waits" })], 1, 1)).toBe("amber");
  });
});

describe("pullRequestLinkFromInput", () => {
  it("keeps web addresses, reading the number when the host is known", () => {
    expect(pullRequestLinkFromInput(" https://github.com/acme/app/pull/42 ")).toEqual({
      prUrl: "https://github.com/acme/app/pull/42",
      prNumber: 42,
    });
    expect(pullRequestLinkFromInput("https://example.com/review/7")).toEqual({
      prUrl: "https://example.com/review/7",
      prNumber: null,
    });
  });

  it("refuses anything that is not a single web address", () => {
    expect(pullRequestLinkFromInput("#42")).toBeNull();
    expect(pullRequestLinkFromInput("https://github.com/a b")).toBeNull();
    expect(pullRequestLinkFromInput(`https://x.dev/${"a".repeat(2_000)}`)).toBeNull();
  });
});

describe("recurringProjectTasks", () => {
  const task = (id: string, patch: Partial<ScheduledTask>) =>
    ({
      id: ScheduledTaskId.make(id),
      projectId: PROJECT,
      enabled: true,
      nextRunAt: null,
      schedule: { type: "interval", everyMs: 60_000 },
      ...patch,
    }) as ScheduledTask;

  it("keeps this project's timed tasks, soonest run first and paused ones last", () => {
    const tasks = [
      task("paused", { enabled: false, nextRunAt: "2026-10-13T08:00:00.000Z" }),
      task("later", { nextRunAt: "2026-10-14T09:00:00.000Z" }),
      task("hook", { schedule: { type: "webhook" } as ScheduledTask["schedule"] }),
      task("other", { projectId: OTHER, nextRunAt: "2026-10-13T07:00:00.000Z" }),
      task("soon", { nextRunAt: "2026-10-13T09:00:00.000Z" }),
    ];
    expect(recurringProjectTasks(tasks, PROJECT).map((entry) => entry.id)).toEqual([
      "soon",
      "later",
      "paused",
    ]);
  });
});

describe("previewThreadFor", () => {
  const LOCAL = EnvironmentId.make("local");
  const shell = (id: string, patch: Partial<Parameters<typeof previewThreadFor>[0][number]>) => ({
    environmentId: LOCAL,
    id: ThreadId.make(id),
    projectId: PROJECT,
    updatedAt: "2026-10-10T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    ...patch,
  });

  it("picks the project's most recently updated live thread on that machine", () => {
    const shells = [
      shell("old", {}),
      shell("new", { updatedAt: "2026-10-12T00:00:00.000Z" }),
      shell("archived", { updatedAt: "2026-10-13T00:00:00.000Z", archivedAt: "2026-10-13" }),
      shell("deleted", { updatedAt: "2026-10-13T00:00:00.000Z", deletedAt: "2026-10-13" }),
      shell("elsewhere", {
        updatedAt: "2026-10-13T00:00:00.000Z",
        environmentId: EnvironmentId.make("remote"),
      }),
      shell("other-project", { updatedAt: "2026-10-13T00:00:00.000Z", projectId: OTHER }),
    ];
    expect(previewThreadFor(shells, LOCAL, PROJECT)).toBe("new");
    expect(previewThreadFor(shells, LOCAL, ProjectId.make("none"))).toBeNull();
  });
});
