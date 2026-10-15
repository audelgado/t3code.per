import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn.ts";

const field = "w-full rounded-lg border border-input bg-card px-3 py-2 text-fg placeholder:text-muted-fg";

export const Input = ({ className, ...p }: ComponentProps<"input">) => (
  <input className={cn(field, className)} {...p} />
);
export const Textarea = ({ className, ...p }: ComponentProps<"textarea">) => (
  <textarea className={cn(field, "min-h-28 resize-y", className)} {...p} />
);
export const Select = ({ className, ...p }: ComponentProps<"select">) => (
  <select className={cn(field, "h-10", className)} {...p} />
);

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="grid gap-1">
    <span className="text-xs font-medium text-muted-fg">{label}</span>
    {children}
  </label>
);

export const Badge = ({ className, ...p }: ComponentProps<"span">) => (
  <span
    className={cn("inline-flex items-center rounded-full bg-accent px-2 py-0.5 text-xs text-muted-fg", className)}
    {...p}
  />
);

export const Card = ({ className, ...p }: ComponentProps<"div">) => (
  <div className={cn("rounded-xl border border-border bg-card p-3", className)} {...p} />
);

export const Section = ({ title, count, children }: { title: string; count?: number; children: ReactNode }) => (
  <section className="grid gap-2">
    <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-fg uppercase">
      {title}
      {count ? <span className="font-normal normal-case">{count}</span> : null}
    </h2>
    {children}
  </section>
);

export const Empty = ({ children }: { children: ReactNode }) => (
  <p className="rounded-xl border border-dashed border-border p-4 text-center text-muted-fg">{children}</p>
);
