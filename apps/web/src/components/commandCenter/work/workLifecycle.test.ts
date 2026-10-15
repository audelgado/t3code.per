import { expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { changeWorkLifecycle, type CloseProgress } from "./workLifecycle";
import { testItem } from "./workTestFixtures";
const item = { ...testItem(), threadIds: [ThreadId.make("a"), ThreadId.make("b")] };
const start: CloseProgress = { item, archived: [], removed: false, closed: false, error: null };
it("retains removal and successful archives on partial close, then reopens only completed steps", async () => {
  const calls: string[] = [];
  const changes: CloseProgress[] = [];
  const commands = {
    remove: async () => {
      calls.push("remove");
    },
    create: async () => {
      calls.push("create");
    },
    archive: async (id: ThreadId) => {
      calls.push(`archive:${id}`);
      if (id === "b") throw new Error("offline");
    },
    unarchive: async (id: ThreadId) => {
      calls.push(`unarchive:${id}`);
    },
  };
  const closed = await changeWorkLifecycle("close", start, commands, (state) =>
    changes.push(state),
  );
  expect(closed.removed).toBe(true);
  expect(closed.archived).toEqual([ThreadId.make("a")]);
  expect(closed.closed).toBe(false);
  expect(closed.error).toContain("offline");
  expect(changes[1]?.removed).toBe(true);
  const reopened = await changeWorkLifecycle("reopen", closed, commands, () => {});
  expect(calls).toEqual(["remove", "archive:a", "archive:b", "create", "unarchive:a"]);
  expect(reopened.archived).toEqual([]);
  expect(reopened.removed).toBe(false);
  expect(reopened.error).toBeNull();
});
it("keeps threads archived if restoring the worktree fails and safely retries", async () => {
  const calls: string[] = [];
  let fail = true;
  const commands = {
    remove: async () => {},
    archive: async () => {},
    create: async () => {
      calls.push("create");
      if (fail) throw new Error("path occupied");
    },
    unarchive: async (id: ThreadId) => {
      calls.push(`unarchive:${id}`);
    },
  };
  const closed = await changeWorkLifecycle("close", start, commands, () => {});
  const failed = await changeWorkLifecycle("reopen", closed, commands, () => {});
  expect(failed.removed).toBe(true);
  expect(failed.archived).toEqual(item.threadIds);
  expect(calls).toEqual(["create"]);
  fail = false;
  const reopened = await changeWorkLifecycle("reopen", failed, commands, () => {});
  expect(reopened.archived).toEqual([]);
  expect(calls).toEqual(["create", "create", "unarchive:a", "unarchive:b"]);
});
it("does not archive anything after worktree removal fails", async () => {
  const calls: string[] = [];
  const failed = await changeWorkLifecycle(
    "close",
    start,
    {
      remove: async () => {
        throw new Error("dirty");
      },
      create: async () => {},
      archive: async () => {
        calls.push("archive");
      },
      unarchive: async () => {},
    },
    () => {},
  );
  expect(calls).toEqual([]);
  expect(failed.removed).toBe(false);
  expect(failed.archived).toEqual([]);
  expect(failed.error).toContain("dirty");
});
