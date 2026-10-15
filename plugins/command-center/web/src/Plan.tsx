import { Merge, Plus, RotateCcw, X } from "lucide-react";
import type { PlanStep } from "../../server/plan.ts";
import { Button } from "./ui/Button.tsx";
import { Card, Input } from "./ui/fields.tsx";

/** One task per step; in order, each step waits for the one before it. */
export const toPlanSteps = (steps: string[], ordered: boolean): PlanStep[] =>
  steps.map((prompt, i) => ({ prompt, ...(ordered && i > 0 ? { after: [i - 1] } : {}) }));

interface Props {
  steps: string[];
  ordered: boolean;
  /** True once the user changed the split; Reset then goes back to the automatic one. */
  edited: boolean;
  onSteps(steps: string[]): void;
  onOrdered(ordered: boolean): void;
  onReset(): void;
}

/** Editable preview of a request split into steps (see splitRequest). */
export function Plan({ steps, ordered, edited, onSteps, onOrdered, onReset }: Props) {
  const set = (i: number, text: string) => onSteps(steps.map((s, j) => (j === i ? text : s)));
  const merge = (i: number) => onSteps([...steps.slice(0, i), `${steps[i]}, ${steps[i + 1]}`, ...steps.slice(i + 2)]);
  return (
    <Card className="grid gap-2">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-muted-fg">
          {steps.length === 0 ? "No steps yet" : `${steps.length} ${steps.length === 1 ? "task" : "tasks"}`}
        </span>
        {edited && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw className="size-4" aria-hidden /> Reset
          </Button>
        )}
      </div>
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          <span className="w-5 shrink-0 text-center text-xs text-muted-fg">{i + 1}</span>
          <Input aria-label={`Step ${i + 1}`} value={s} onChange={(e) => set(i, e.target.value)} />
          {i < steps.length - 1 && (
            <Button variant="ghost" size="icon" aria-label={`Merge step ${i + 1} with the next`} onClick={() => merge(i)}>
              <Merge className="size-4" aria-hidden />
            </Button>
          )}
          <Button variant="ghost" size="icon" aria-label={`Remove step ${i + 1}`} onClick={() => onSteps(steps.filter((_, j) => j !== i))}>
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => onSteps([...steps, ""])} disabled={steps.length >= 12}>
          <Plus className="size-4" aria-hidden /> Step
        </Button>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-5" checked={ordered} onChange={(e) => onOrdered(e.target.checked)} />
          Run in order
        </label>
      </div>
    </Card>
  );
}
