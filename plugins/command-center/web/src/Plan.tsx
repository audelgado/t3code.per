import { Merge, Plus, RotateCcw, X } from "lucide-react";
import { MAX_STEPS, type PlanStep } from "../../server/plan.ts";
import { Button } from "./ui/Button.tsx";
import { Input } from "./ui/fields.tsx";

/** One task per step; in order, each step waits for the one before it. */
export const toPlanSteps = (steps: string[], ordered: boolean): PlanStep[] =>
  steps.map((prompt, i) => ({ prompt, ...(ordered && i > 0 ? { after: [i - 1] } : {}) }));

interface Props {
  steps: string[];
  ordered: boolean;
  /** True once the user changed the split; "Restablecer" then goes back to the automatic one. */
  edited: boolean;
  onSteps(steps: string[]): void;
  onOrdered(ordered: boolean): void;
  onReset(): void;
}

/** Editable list of the steps a request is split into (see splitRequest or the coordinator's draft). */
export function Plan({ steps, ordered, edited, onSteps, onOrdered, onReset }: Props) {
  const set = (i: number, text: string) => onSteps(steps.map((s, j) => (j === i ? text : s)));
  const merge = (i: number) => onSteps([...steps.slice(0, i), `${steps[i]}, ${steps[i + 1]}`, ...steps.slice(i + 2)]);
  return (
    <section aria-label="Pasos" className="overflow-hidden rounded-[10px] border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-soft px-3 py-1.5">
        <span className="flex-1 text-xs font-medium text-muted-fg">
          {steps.length === 0 ? "Todavía no hay pasos" : `${steps.length} ${steps.length === 1 ? "tarea" : "tareas"}${steps.length >= MAX_STEPS ? " (máximo)" : ""}`}
        </span>
        {edited && (
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw className="size-4" aria-hidden /> Restablecer
          </Button>
        )}
      </header>
      <div className="divide-y divide-soft">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-1 px-3 py-1">
            <span className="w-5 shrink-0 text-xs text-muted-fg tabular-nums">{i + 1}</span>
            <Input aria-label={`Paso ${i + 1}`} value={s} onChange={(e) => set(i, e.target.value)} className="min-w-0 flex-1 border-0 bg-transparent px-1.5" />
            {i < steps.length - 1 && (
              <Button variant="ghost" size="icon" aria-label={`Unir el paso ${i + 1} con el siguiente`} onClick={() => merge(i)}>
                <Merge className="size-4" aria-hidden />
              </Button>
            )}
            <Button variant="ghost" size="icon" aria-label={`Quitar el paso ${i + 1}`} onClick={() => onSteps(steps.filter((_, j) => j !== i))}>
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ))}
      </div>
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-soft px-3 py-1.5">
        <Button variant="ghost" size="sm" onClick={() => onSteps([...steps, ""])} disabled={steps.length >= MAX_STEPS}>
          <Plus className="size-4" aria-hidden /> Paso
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-5 md:size-4" checked={ordered} onChange={(e) => onOrdered(e.target.checked)} />
          Ejecutar en orden
        </label>
      </footer>
    </section>
  );
}
