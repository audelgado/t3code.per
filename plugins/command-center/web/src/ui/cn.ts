import { twMerge } from "tailwind-merge";

export const cn = (...c: Array<string | false | null | undefined>) => twMerge(c.filter(Boolean).join(" "));

// Kept so existing imports keep working; the formatters live in ../look.ts.
export { ago, at } from "../look.ts";
