import type {
  CommandCenterCost,
  CommandCenterIncome,
  CommandCenterIncomeStatus,
  ProjectId,
} from "@t3tools/contracts";

/** Click order for the income status badge. */
export const NEXT_INCOME_STATUS: Record<CommandCenterIncomeStatus, CommandCenterIncomeStatus> = {
  pending: "paid",
  paid: "overdue",
  overdue: "pending",
};

/** `YYYY-MM` for a local date. */
export function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Totals are only meaningful in one currency: the one most rows use (USD when empty). */
export function displayCurrency(
  income: ReadonlyArray<CommandCenterIncome>,
  costs: ReadonlyArray<CommandCenterCost>,
) {
  const counts = new Map<string, number>();
  for (const row of [...income, ...costs]) {
    counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
  }
  let best = "USD";
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) [best, bestCount] = [currency, count];
  }
  return best;
}

/** A cost counts in a month when it was created by then and not archived during or before it. */
function costActiveIn(cost: CommandCenterCost, month: string) {
  return (
    cost.createdAt.slice(0, 7) <= month &&
    (cost.archivedAt === null || cost.archivedAt.slice(0, 7) > month)
  );
}

/**
 * Monthly cost per project. Each active cost is split evenly across its projects, leftover
 * cents going to the first ones so the parts add up to the cost. Costs with no project land
 * under `null`.
 */
export function costByProject(costs: ReadonlyArray<CommandCenterCost>, currency: string) {
  const totals = new Map<ProjectId | null, number>();
  const add = (projectId: ProjectId | null, cents: number) =>
    totals.set(projectId, (totals.get(projectId) ?? 0) + cents);
  for (const cost of costs) {
    if (cost.archivedAt !== null || cost.currency !== currency) continue;
    const projectIds = [...new Set(cost.projectIds)];
    if (projectIds.length === 0) {
      add(null, cost.monthlyCents);
      continue;
    }
    const share = Math.floor(cost.monthlyCents / projectIds.length);
    const leftover = cost.monthlyCents - share * projectIds.length;
    projectIds.forEach((projectId, index) => add(projectId, share + (index < leftover ? 1 : 0)));
  }
  return totals;
}

export interface FinanceMonth {
  readonly key: string;
  readonly date: Date;
  readonly incomeCents: number;
  readonly costCents: number;
}

/** KPIs and the last six months, in `currency` only; `otherCurrencyRows` counts what was left out. */
export function financeSummary(
  income: ReadonlyArray<CommandCenterIncome>,
  costs: ReadonlyArray<CommandCenterCost>,
  currency: string,
  now: Date,
) {
  const months: Array<FinanceMonth> = [];
  for (let offset = 5; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = monthKey(date);
    months.push({
      key,
      date,
      incomeCents: income
        .filter((row) => row.currency === currency && row.date.startsWith(key))
        .reduce((sum, row) => sum + row.amountCents, 0),
      costCents: costs
        .filter((cost) => cost.currency === currency && costActiveIn(cost, key))
        .reduce((sum, cost) => sum + cost.monthlyCents, 0),
    });
  }
  const unpaid = income.filter((row) => row.currency === currency && row.status !== "paid");
  const incomeThisMonth = months[5]!.incomeCents;
  const fixedCosts = costs
    .filter((cost) => cost.currency === currency && cost.archivedAt === null)
    .reduce((sum, cost) => sum + cost.monthlyCents, 0);
  return {
    months,
    incomeThisMonth,
    fixedCosts,
    resultCents: incomeThisMonth - fixedCosts,
    owedCents: unpaid.reduce((sum, row) => sum + row.amountCents, 0),
    overdueCount: unpaid.filter((row) => row.status === "overdue").length,
    otherCurrencyRows:
      income.filter((row) => row.currency !== currency).length +
      costs.filter((cost) => cost.archivedAt === null && cost.currency !== currency).length,
  };
}

/** `"12.5"` → 1250; null for anything that is not a non-negative amount. */
export function parseCents(text: string) {
  const value = Number(text.trim().replace(",", "."));
  if (text.trim() === "" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}
