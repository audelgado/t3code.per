import { useEffect, useRef } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { Kbd } from "../../ui/kbd";
import { StatusDot } from "../StatusDot";
import type { WorkItem } from "./workItems";
export function WorkRotator({
  items,
  focused,
  onFocus,
  onOpen,
  machineLabel,
}: {
  readonly items: readonly WorkItem[];
  readonly focused: WorkItem | undefined;
  readonly onFocus: (key: string) => void;
  readonly onOpen: (item: WorkItem) => void;
  readonly machineLabel: (item: WorkItem) => string;
}) {
  // [ and ] walk every item; the strip shows a 12-card window that always contains the focused one.
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === focused?.key),
  );
  const start = Math.min(Math.max(0, index - 5), Math.max(0, items.length - 12));
  const strip = useRef<HTMLDivElement>(null);
  const focusedKey = focused?.key;
  useEffect(() => {
    if (focusedKey === undefined) return;
    strip.current
      ?.querySelector(`[data-work-key="${CSS.escape(focusedKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [focusedKey]);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          Quick switch <span className="text-muted-foreground">{items.length}</span>
        </h2>
        <div className="flex gap-1">
          <Kbd>[</Kbd>
          <Kbd>]</Kbd>
          {focused && (
            <Button size="xs" variant="ghost" onClick={() => onOpen(focused)}>
              Open <Kbd>Enter</Kbd>
            </Button>
          )}
        </div>
      </div>
      <div ref={strip} className="flex gap-2 overflow-x-auto pb-2" aria-label="Active work">
        {items.slice(start, start + 12).map((item) => (
          <button
            type="button"
            key={item.key}
            data-work-key={item.key}
            onClick={() => onFocus(item.key)}
            aria-pressed={focused?.key === item.key}
            className={cn(
              "w-52 shrink-0 space-y-2 rounded-xl border bg-card/40 p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              focused?.key === item.key ? "border-primary" : "border-border/60",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md bg-muted text-xs font-medium">
                {item.project.title.slice(0, 2).toUpperCase()}
              </span>
              <span className="truncate text-sm font-medium">{item.project.title}</span>
            </div>
            <p className="truncate font-mono text-xs" aria-label={item.branch}>
              {item.branch}
            </p>
            <div className="flex items-center justify-between gap-2">
              <StatusDot
                tone={
                  item.agent === "needs-you"
                    ? "warning"
                    : item.agent === "working"
                      ? "info"
                      : "muted"
                }
                label={item.agent.replace("-", " ")}
              />
              <span className="truncate text-xs text-muted-foreground">{machineLabel(item)}</span>
            </div>
          </button>
        ))}
      </div>
      {items.length > 12 && (
        <p className="text-xs text-muted-foreground">
          {index + 1} of {items.length}. The rest are in the project lanes below.
        </p>
      )}
    </div>
  );
}
