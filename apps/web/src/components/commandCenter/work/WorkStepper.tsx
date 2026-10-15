import { cn } from "~/lib/utils";
import { WORK_STAGES, type WorkStage } from "./workItems";
export function WorkStepper({
  stage,
  compact = false,
}: WorkStage & { readonly compact?: boolean }) {
  return (
    <ol aria-label={`Progress: ${WORK_STAGES[stage]}`} className="flex min-w-0 gap-1">
      {WORK_STAGES.map((label, index) => (
        <li
          key={label}
          aria-current={index === stage ? "step" : undefined}
          aria-label={label}
          className={cn("min-w-0 flex-1", compact && "max-w-3")}
        >
          <span
            className={cn(
              "block rounded-full",
              compact ? "size-1.5" : "h-1",
              index <= stage ? "bg-primary" : "bg-muted",
            )}
          />
          {!compact && (
            <span className="mt-1 block truncate text-3xs text-muted-foreground">{label}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
