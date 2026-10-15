import { cn } from "~/lib/utils";

const tones = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-primary",
  muted: "bg-muted-foreground",
} as const;

/** Shared status marker for work, agents and machine summaries. */
export function StatusDot({
  tone,
  label,
  hideLabel = false,
}: {
  readonly tone: keyof typeof tones;
  readonly label: string;
  readonly hideLabel?: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", tones[tone])} />
      <span className={hideLabel ? "sr-only" : "truncate"}>{label}</span>
    </span>
  );
}
