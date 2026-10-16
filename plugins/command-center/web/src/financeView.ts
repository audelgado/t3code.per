// Pure helpers for the Dinero screen: amounts, dates and the labels shared by its rows. es-AR throughout.
import type { IncomeStatus } from "../../server/finance.ts";
import type { Tone } from "./look.ts";

/** "12.5" or "12,5" -> 1250; null for anything that is not a non-negative amount. */
export function toCents(s: string) {
  const v = Number(s.trim().replace(",", "."));
  return s.trim() === "" || !Number.isFinite(v) || v < 0 ? null : Math.round(v * 100);
}

/** "$ 12.400" in es-AR; cents only when there are any. `hide` masks the amount (per-device privacy toggle). */
export function money(cents: number, currency: string, hide: boolean) {
  if (hide) return "••••";
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat("es-AR", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toLocaleString("es-AR")}`; // not a valid ISO code
  }
}

/** "2026-10" -> "oct". */
export const monthLabel = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5)) - 1, 1).toLocaleDateString("es-AR", { month: "short" }).replace(".", "");

/** "2026-10-05" -> "5 oct". */
export const dayLabel = (date: string) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))).toLocaleDateString("es-AR", { day: "numeric", month: "short" }).replace(".", "");

export const INCOME_STATUS: Record<IncomeStatus, { label: string; tone: Tone }> = {
  pending: { label: "Pendiente", tone: "need" },
  paid: { label: "Cobrado", tone: "ok" },
  overdue: { label: "Vencido", tone: "fail" },
};

/** Tapping a status chip cycles through these. */
export const NEXT_STATUS: Record<IncomeStatus, IncomeStatus> = { pending: "paid", paid: "overdue", overdue: "pending" };
