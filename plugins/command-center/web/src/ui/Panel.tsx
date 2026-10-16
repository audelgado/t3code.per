import type { ReactNode } from "react";
import { cn } from "./cn.ts";

/** Small uppercase heading with an optional count and a right-side action (e.g. a "Ver todo" link). */
export function SectionHeader({ title, count, action, className }: { title: string; count?: number; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-6 items-center gap-2", className)}>
      <h2 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">{title}</h2>
      {count !== undefined && <span className="text-xs text-muted-fg tabular-nums">{count}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/**
 * The design's card: a white panel with an optional header row and divided rows.
 * Children are the rows; give each `px-4 py-3`.
 */
export function Panel({ title, count, action, className, children }: { title?: string; count?: number; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("overflow-hidden rounded-card border border-line bg-panel", className)}>
      {title && (
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          {count !== undefined && <span className="text-sm text-muted-fg tabular-nums">{count}</span>}
          {action && <div className="ml-auto">{action}</div>}
        </header>
      )}
      <div className="divide-y divide-soft">{children}</div>
    </section>
  );
}
