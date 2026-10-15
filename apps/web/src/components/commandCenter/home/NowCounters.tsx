import type { ReactNode } from "react";
import { Money, useCommandCenter } from "../shared";
import type { CommandCenterTab } from "../tabs";
import type { nowCounts } from "./homeLogic";
import { Gauge, SegmentBar, Sparkline, StageBars } from "./MiniCharts";

export function NowCounters({
  counts,
  completed,
  owedCents,
  currency,
  owedFraction,
  onTabChange,
  onNeedsYou,
}: {
  readonly counts: ReturnType<typeof nowCounts>;
  readonly completed: readonly number[];
  readonly owedCents: number;
  readonly currency: string;
  readonly owedFraction: number;
  readonly onTabChange: (tab: CommandCenterTab) => void;
  readonly onNeedsYou: () => void;
}) {
  const { hidden } = useCommandCenter();
  const counter = (label: string, value: ReactNode, chart: ReactNode, action: () => void) => (
    <button
      type="button"
      onClick={action}
      className="flex min-w-0 items-center justify-between gap-2 p-4 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
    >
      <span className="min-w-0">
        <span className="block text-xs text-muted-foreground">{label}</span>
        <span className="block truncate text-2xl tabular-nums">{value}</span>
      </span>
      {chart}
    </button>
  );
  return (
    <section
      aria-label="Now"
      className="grid grid-cols-2 overflow-hidden rounded-xl border border-border/60 bg-card/40 divide-x divide-y sm:grid-cols-4 sm:divide-y-0"
    >
      {counter("Working", counts.working, <Sparkline values={completed} />, () =>
        onTabChange("team"),
      )}
      {counter(
        "Needs you",
        Object.values(counts.needsYouByReason).reduce((a, b) => a + b, 0),
        <SegmentBar values={Object.values(counts.needsYouByReason)} />,
        onNeedsYou,
      )}
      {counter(
        "Active work",
        counts.activeWorkByStage.reduce((a, b) => a + b, 0),
        <StageBars values={counts.activeWorkByStage} />,
        () => onTabChange("work"),
      )}
      {counter(
        "Owed",
        <Money cents={owedCents} currency={currency} />,
        hidden ? null : <Gauge fraction={owedFraction} />,
        () => onTabChange("finance"),
      )}
    </section>
  );
}
