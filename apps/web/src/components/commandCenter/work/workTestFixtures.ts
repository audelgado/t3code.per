import type { WorkItem } from "./workItems";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
export function testItem(index = 0, patch: Partial<WorkItem> = {}): WorkItem {
  const environmentId = EnvironmentId.make("pc");
  const projectId = ProjectId.make(`p${index}`);
  return {
    key: `w${index}`,
    projectKey: `pc:p${index}`,
    environmentId,
    projectId,
    project: {
      environmentId,
      id: projectId,
      title: `Project ${index}`,
      workspaceRoot: `/repo${index}`,
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-01",
      updatedAt: "2026-10-14",
    },
    branch: `feature${index}`,
    worktreePath: `/wt${index}`,
    cwd: `/wt${index}`,
    threadIds: [ThreadId.make(`t${index}`)],
    latestThreadId: ThreadId.make(`t${index}`),
    agent: "idle",
    pr: null,
    updatedAt: `2026-10-${String((index % 14) + 1).padStart(2, "0")}`,
    ...patch,
  };
}
