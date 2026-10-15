import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

const button = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg active:opacity-90",
        outline: "border-input bg-card active:bg-accent",
        ghost: "text-muted-fg active:bg-accent",
        danger: "bg-bad/10 text-bad active:bg-bad/20",
      },
      size: { default: "h-10 px-4", sm: "h-9 px-3", icon: "size-9" },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

export function Button({
  variant,
  size,
  className,
  ...p
}: ComponentProps<"button"> & VariantProps<typeof button>) {
  return <button type="button" className={cn(button({ variant, size }), className)} {...p} />;
}

/** Same look for links. */
export function LinkButton({
  variant,
  size,
  className,
  ...p
}: ComponentProps<"a"> & VariantProps<typeof button>) {
  return <a className={cn(button({ variant, size }), className)} {...p} />;
}
