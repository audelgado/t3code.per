import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectEntryKey } from "../projects/projectDirectory";
import type { WorkItem } from "../work/workItems";
import { completedBuckets, nowCounts, pinnedProjects } from "./homeLogic";

const project = (id: string, environment = "pc"): EnvironmentProject => ({
  id: ProjectId.make(id),
  environmentId: EnvironmentId.make(environment),
  title: id,
  workspaceRoot: `/${id}`,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-14T00:00:00Z",
});
const work = (patch: Partial<WorkItem> = {}): WorkItem => ({
  key: "work",
  projectKey: projectEntryKey(project("a")),
  project: project("a"),
  environmentId: EnvironmentId.make("pc"),
  projectId: ProjectId.make("a"),
  branch: "feature",
  worktreePath: null,
  cwd: "/a",
  threadIds: [ThreadId.make("thread")],
  latestThreadId: ThreadId.make("thread"),
  agent: "idle",
  pr: null,
  updatedAt: "2026-10-14T00:00:00Z",
  ...patch,
});

describe("Home overview", () => {
  it("keeps explicit pins in manual order, caps at eight, and never joins clones", () => {
    const projects = Array.from({ length: 11 }, (_, index) => project(String(index)));
    const clone = project("0", "vps");
    const entries = [
      ...projects.map((value) => ({
        key: projectEntryKey(value),
        pinned: true,
        groupId: null,
        url: null,
      })),
      { key: "pc:missing", pinned: true, groupId: null, url: null },
    ];
    const pins = pinnedProjects(
      entries,
      [...projects, clone],
      [projectEntryKey(projects[9]!), projectEntryKey(projects[3]!)],
    );
    expect(pins.map((value) => value.id)).toEqual(["9", "3", "0", "1", "2", "4", "5", "6"]);
    expect(pins.every((value) => value.environmentId === "pc")).toBe(true);
    expect(pinnedProjects([], projects, [])).toEqual([]);
  });
  it("counts every attention reason and only observed stages without VCS", () => {
    const counts = nowCounts(
      [],
      [
        { kind: "thread", reason: "approval" },
        { kind: "thread", reason: "input" },
        { kind: "thread", reason: "input" },
        { kind: "thread", reason: "plan" },
        { kind: "offline" },
      ],
      [
        work(),
        work({ agent: "working" }),
        work({
          pr: {
            number: 1,
            url: "https://example.com/1",
            state: "open",
            isDraft: false,
            checksState: undefined,
          },
        }),
        work({
          pr: {
            number: 2,
            url: "https://example.com/2",
            state: "merged",
            isDraft: false,
            checksState: undefined,
          },
        }),
      ],
    );
    expect(counts).toEqual({
      working: 0,
      needsYouByReason: { approval: 1, input: 2, plan: 1, other: 1 },
      activeWorkByStage: [1, 1, 0, 0, 1, 1],
    });
  });
  it("buckets observed completions at UTC boundaries, excluding deleted/subagent/future runs", () => {
    const shell = (
      completedAt: string,
      patch: Partial<Parameters<typeof completedBuckets>[0][number]> = {},
    ): Parameters<typeof completedBuckets>[0][number] => ({
      deletedAt: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make("root"),
      },
      latestRun: {
        runId: RunId.make("run"),
        status: "completed",
        requestedAt: null,
        startedAt: null,
        completedAt,
        assistantMessageId: null,
      },
      ...patch,
    });
    expect(
      completedBuckets(
        [
          shell("2026-10-08T00:00:00Z"),
          shell("2026-10-13T23:59:59Z"),
          shell("2026-10-14T00:00:00Z"),
          shell("2026-10-07T23:59:59Z"),
          shell("2026-10-14T00:00:01Z"),
          shell("2026-10-14T00:00:00Z", { deletedAt: "2026-10-14" }),
          shell("2026-10-14T00:00:00Z", {
            lineage: {
              parentThreadId: ThreadId.make("parent"),
              relationshipToParent: "subagent",
              rootThreadId: ThreadId.make("root"),
            },
          }),
        ],
        Date.parse("2026-10-14T00:00:00Z"),
      ),
    ).toEqual([1, 0, 0, 0, 0, 1, 1]);
  });
});
