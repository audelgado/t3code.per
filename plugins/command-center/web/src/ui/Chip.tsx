import type { ReactNode } from "react";
import type { LinkStatus, TaskStatus, ThreadStatus } from "../../../server/types.ts";
import { statusTone, TONES, type Tone } from "../look.ts";
import { cn } from "./cn.ts";

/** Coloured pill. `tone` picks the foreground/background pair from the palette. */
export function Chip({ tone = "queue", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  const { fg, bg } = TONES[tone];
  return (
    <span style={{ color: fg, background: bg }} className={cn("inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-semibold whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

/** Chip with the Spanish label and tone of a task, thread or machine-link status. */
export function StatusChip({ status, className }: { status: TaskStatus | ThreadStatus | LinkStatus; className?: string }) {
  const { label, tone } = statusTone(status);
  return <Chip tone={tone} className={className}>{label}</Chip>;
}
