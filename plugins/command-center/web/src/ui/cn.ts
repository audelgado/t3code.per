import { twMerge } from "tailwind-merge";

export const cn = (...c: Array<string | false | null | undefined>) => twMerge(c.filter(Boolean).join(" "));

/** "5m ago" style age for an ISO timestamp. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Local date+time for a future/past ISO timestamp. */
export const at = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
