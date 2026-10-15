import type { ThreadId } from "@t3tools/contracts";
import type { WorkItem } from "./workItems";
export interface CloseProgress {
  readonly item: WorkItem;
  readonly archived: readonly ThreadId[];
  readonly removed: boolean;
  readonly closed: boolean;
  readonly error: string | null;
}
interface LifecycleCommands {
  readonly remove: () => Promise<void>;
  readonly create: () => Promise<void>;
  readonly archive: (id: ThreadId) => Promise<void>;
  readonly unarchive: (id: ThreadId) => Promise<void>;
}
/** Persist each successful step before starting the next, including during recovery. */
export async function changeWorkLifecycle(
  direction: "close" | "reopen",
  progress: CloseProgress,
  commands: LifecycleCommands,
  onProgress: (progress: CloseProgress) => void,
) {
  let current: CloseProgress = { ...progress, error: null };
  const save = (next: CloseProgress) => {
    current = next;
    onProgress(current);
  };
  save(current);
  try {
    if (direction === "close") {
      if (current.item.worktreePath && !current.removed) {
        await commands.remove();
        save({ ...current, removed: true });
      }
      for (const id of current.item.threadIds)
        if (!current.archived.includes(id)) {
          await commands.archive(id);
          save({ ...current, archived: [...current.archived, id] });
        }
      save({ ...current, closed: true });
    } else {
      if (current.removed) {
        await commands.create();
        save({ ...current, removed: false });
      }
      for (const id of current.archived) {
        await commands.unarchive(id);
        save({ ...current, archived: current.archived.filter((entry) => entry !== id) });
      }
      save({ ...current, closed: false });
    }
  } catch (cause) {
    save({ ...current, error: String(cause) });
  }
  return current;
}
