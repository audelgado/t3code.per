import type { TaskStatus, ThreadStatus, LinkStatus } from "../../server/types.ts";
import { cn } from "./ui/cn.ts";

type Status = TaskStatus | ThreadStatus | LinkStatus;

const tone: Partial<Record<Status, string>> = {
  running: "bg-info",
  starting: "bg-info",
  preparing: "bg-info",
  connecting: "bg-info",
  waiting: "bg-warn",
  needs_you: "bg-warn",
  pending_approval: "bg-warn",
  incompatible: "bg-warn",
  done: "bg-ok",
  completed: "bg-ok",
  online: "bg-ok",
  failed: "bg-bad",
  unauthorized: "bg-bad",
  offline: "bg-bad",
};

/** Static dot; the colour is the status. No animation. */
export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      role="img"
      aria-label={status.replace("_", " ")}
      className={cn("inline-block size-2 shrink-0 rounded-full", tone[status] ?? "bg-muted-fg/50", className)}
    />
  );
}
