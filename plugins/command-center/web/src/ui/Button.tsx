import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn.ts";

const button = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-ctl border border-transparent font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary: "border-primary bg-primary text-primary-fg hover:brightness-90 active:opacity-90",
        outline: "border-line bg-panel hover:bg-soft active:bg-soft",
        ghost: "text-muted-fg hover:bg-soft hover:text-fg active:bg-soft",
        danger: "border-line bg-panel text-fail hover:bg-fail-bg active:bg-fail-bg",
      },
      // Phone targets stay 40px; desktop is the denser 30px of the design.
      size: { default: "h-10 px-4 text-sm md:h-[30px] md:px-3", sm: "h-9 px-3 text-sm md:h-[26px] md:px-2.5 md:text-xs", icon: "size-10 md:size-[30px]", composer: "size-[44px] rounded-full" },
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
