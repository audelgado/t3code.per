import type { LinkStatus, TaskStatus, ThreadStatus } from "../../server/types.ts";
import { statusTone } from "./look.ts";
import { cn } from "./ui/cn.ts";

/** Static dot; the colour is the status. No animation. */
export function StatusDot({ status, className }: { status: TaskStatus | ThreadStatus | LinkStatus; className?: string }) {
  const { label, fg } = statusTone(status);
  return <span role="img" aria-label={label} style={{ background: fg }} className={cn("inline-block size-2 shrink-0 rounded-full", className)} />;
}
