import {
  CommandCenterCostId,
  CommandCenterIncomeId,
  ProjectId,
  type CommandCenterCost,
  type CommandCenterIncome,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { costByProject, financeSummary, parseCents } from "./logic";

const A = ProjectId.make("a");
const B = ProjectId.make("b");
const C = ProjectId.make("c");

const cost = (
  id: string,
  monthlyCents: number,
  projectIds: ReadonlyArray<ProjectId>,
  extra: Partial<CommandCenterCost> = {},
): CommandCenterCost => ({
  id: CommandCenterCostId.make(id),
  concept: id,
  category: "",
  monthlyCents,
  currency: "USD",
  projectIds,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  ...extra,
});

const income = (
  id: string,
  date: string,
  amountCents: number,
  status: CommandCenterIncome["status"],
): CommandCenterIncome => ({
  id: CommandCenterIncomeId.make(id),
  concept: id,
  clientName: "Client",
  date,
  amountCents,
  currency: "USD",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("costByProject", () => {
  it("splits each cost evenly and keeps every cent", () => {
    const totals = costByProject(
      [
        cost("vps", 1000, [A, B, C]),
        cost("domain", 500, [A]),
        cost("tools", 300, []),
        cost("old", 9999, [A], { archivedAt: "2026-02-01T00:00:00.000Z" }),
        cost("eur", 9999, [A], { currency: "EUR" }),
      ],
      "USD",
    );
    expect(totals.get(A)).toBe(334 + 500);
    expect(totals.get(B)).toBe(333);
    expect(totals.get(C)).toBe(333);
    expect(totals.get(null)).toBe(300);
  });
});

describe("financeSummary", () => {
  it("totals the current month and the six-month history", () => {
    const summary = financeSummary(
      [
        income("oct-paid", "2026-10-02", 5000, "paid"),
        income("oct-pending", "2026-10-20", 2000, "pending"),
        income("sep-overdue", "2026-09-15", 1000, "overdue"),
      ],
      [
        cost("vps", 1500, [A]),
        cost("archived-aug", 700, [A], { archivedAt: "2026-08-10T00:00:00.000Z" }),
        cost("new-oct", 100, [], { createdAt: "2026-10-05T00:00:00.000Z" }),
      ],
      "USD",
      new Date(2026, 9, 13),
    );
    expect(summary.incomeThisMonth).toBe(7000);
    expect(summary.fixedCosts).toBe(1600);
    expect(summary.resultCents).toBe(5400);
    expect(summary.owedCents).toBe(3000);
    expect(summary.overdueCount).toBe(1);
    expect(summary.months.map((month) => month.key)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    expect(summary.months.map((month) => month.costCents)).toEqual([
      2200, 2200, 2200, 1500, 1500, 1600,
    ]);
    expect(summary.months[4]!.incomeCents).toBe(1000);
  });
});

describe("parseCents", () => {
  it("accepts dot or comma decimals and rejects junk", () => {
    expect(parseCents("12.5")).toBe(1250);
    expect(parseCents("0,99")).toBe(99);
    expect(parseCents("")).toBeNull();
    expect(parseCents("-1")).toBeNull();
    expect(parseCents("abc")).toBeNull();
  });
});
