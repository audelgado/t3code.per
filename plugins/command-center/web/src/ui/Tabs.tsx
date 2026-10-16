import { cn } from "./cn.ts";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  /** Set for route tabs (renders a link). Without it the tab is a button that calls `onChange`. */
  href?: string;
}

/** Segmented control: Lista/Tablero/Flujos, Todos/Artefactos/Memoria, filters with counts. */
export function Tabs<T extends string>({ items, value, onChange, label, className }: { items: readonly TabItem<T>[]; value: T; onChange?: (id: T) => void; label: string; className?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cn("no-scrollbar inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[9px] bg-[#ecebe6] p-[3px]", className)}>
      {items.map((item) => {
        const selected = item.id === value;
        const cls = cn(
          "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[13px] whitespace-nowrap",
          selected ? "bg-panel font-semibold text-fg shadow-[0_1px_2px_rgba(0,0,0,.06)]" : "text-muted-fg",
        );
        const body = (
          <>
            {item.label}
            {item.count !== undefined && <span className="text-xs tabular-nums opacity-85">{item.count}</span>}
          </>
        );
        return item.href !== undefined ? (
          <a key={item.id} role="tab" aria-selected={selected} href={item.href} className={cls}>{body}</a>
        ) : (
          <button key={item.id} type="button" role="tab" aria-selected={selected} onClick={() => onChange?.(item.id)} className={cls}>{body}</button>
        );
      })}
    </div>
  );
}
