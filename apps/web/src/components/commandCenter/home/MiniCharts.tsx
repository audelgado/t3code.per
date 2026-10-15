export function Sparkline({ values }: { readonly values: readonly number[] }) {
  const max = Math.max(1, ...values);
  const points = values
    .map(
      (value, index) =>
        `${2 + (index * 76) / Math.max(1, values.length - 1)},${22 - (value / max) * 20}`,
    )
    .join(" ");
  return (
    <svg aria-hidden="true" viewBox="0 0 80 24" className="h-6 w-20 shrink-0 text-primary">
      <polyline fill="none" stroke="currentColor" strokeWidth="2" points={points} />
    </svg>
  );
}
export function SegmentBar({ values }: { readonly values: readonly number[] }) {
  const tones = ["bg-warning", "bg-primary", "bg-success", "bg-muted-foreground"];
  return (
    <div aria-hidden="true" className="flex h-2 w-20 overflow-hidden rounded bg-muted">
      {values.map((value, index) => (
        <div
          key={tones[index % tones.length]}
          className={tones[index % tones.length]}
          style={{ flex: value }}
        />
      ))}
    </div>
  );
}
export function StageBars({ values }: { readonly values: readonly number[] }) {
  const max = Math.max(1, ...values);
  return (
    <div aria-hidden="true" className="flex h-6 w-20 items-end gap-1">
      {values.map((value, index) => (
        <div
          key={["created", "working", "committed", "pushed", "pr", "merged"][index]}
          className="min-h-1 flex-1 rounded-sm bg-primary"
          style={{ height: `${Math.max(8, (value / max) * 100)}%`, opacity: value ? 1 : 0.2 }}
        />
      ))}
    </div>
  );
}
export function Gauge({ fraction }: { readonly fraction: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 28" className="h-7 w-12 shrink-0 text-warning">
      <path
        d="M 4 24 A 20 20 0 0 1 44 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        opacity="0.2"
      />
      <path
        d="M 4 24 A 20 20 0 0 1 44 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        pathLength="1"
        strokeDasharray={`${Math.max(0, Math.min(1, fraction))} 1`}
      />
    </svg>
  );
}
