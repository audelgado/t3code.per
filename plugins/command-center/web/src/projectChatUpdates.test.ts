import assert from "node:assert/strict";
import { test } from "node:test";
import type { HomeView, ThreadItem } from "../../server/types.ts";
import { projectChatRevision } from "./projectChatUpdates.ts";

const thread = (projectId: string): ThreadItem => ({ key: `m:${projectId}`, machineId: "m", threadId: projectId, projectId, title: projectId, status: "running", taskId: null, pending: null, planReady: false, waitingUntil: null, preview: null, failed: false, updatedAt: "first", appUrl: "", webUrl: null });

test("unrelated SSE updates do not reload a project chat; its replies and approvals do", () => {
  const view: HomeView = { machines: [], needsYou: [], running: [thread("a"), thread("b")], done: [], queue: [] };
  const before = projectChatRevision(view, "m", "a");
  view.running[1]!.updatedAt = "changed";
  view.assistantVersion = 2;
  assert.equal(projectChatRevision(view, "m", "a"), before);
  view.running[0]!.updatedAt = "new reply";
  assert.notEqual(projectChatRevision(view, "m", "a"), before);
  const updated = projectChatRevision(view, "m", "a");
  const own = view.running.shift()!;
  view.needsYou.push({ kind: "thread", reason: "approval", since: "now", thread: { ...own, pending: { id: "p", kind: "command", summary: "Approve", createdAt: "now" } } });
  assert.notEqual(projectChatRevision(view, "m", "a"), updated);
});
