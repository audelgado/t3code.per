import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";
import { SectionHeader } from "./Panel.tsx";

const field = "w-full rounded-ctl border border-line bg-panel px-3 py-2 text-fg placeholder:text-muted-fg";

export const Input = ({ className, ...p }: ComponentProps<"input">) => (
  <input className={cn(field, className)} {...p} />
);
export const Textarea = ({ className, ...p }: ComponentProps<"textarea">) => (
  <textarea className={cn(field, "min-h-28 resize-y", className)} {...p} />
);
export const Select = ({ className, ...p }: ComponentProps<"select">) => (
  <select className={cn(field, "h-10 py-0", className)} {...p} />
);

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="grid gap-1">
    <span className="text-xs font-medium text-muted-fg">{label}</span>
    {children}
  </label>
);

/** Neutral count/tag chip. For status colours use Chip (ui/Chip.tsx). */
export const Badge = ({ className, ...p }: ComponentProps<"span">) => (
  <span
    className={cn("inline-flex items-center rounded-full bg-soft px-2 py-0.5 text-xs text-muted-fg", className)}
    {...p}
  />
);

/** White rounded panel with padding. For a titled list use Panel (ui/Panel.tsx). */
export const Card = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("rounded-card border border-line bg-panel p-3", className)} {...p} />
);

/** A titled block of rows on the page background. */
export const Section = ({ title, count, action, children }: { title: string; count?: number; action?: ReactNode; children: ReactNode }) => (
  <section className="grid gap-2">
    <SectionHeader title={title} count={count} action={action} />
    {children}
  </section>
);

/** "Nada por acá" by default; pass children for a specific message and `action` for a next step. */
export const EmptyState = ({ children = "Nada por acá", action }: { children?: ReactNode; action?: ReactNode }) => (
  <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-line p-6 text-center text-muted-fg">
    <p>{children}</p>
    {action}
  </div>
);
/** Alias kept for screens written before EmptyState. */
export const Empty = EmptyState;
