// Finance ledger: income rows, recurring monthly costs, totals per client and project.
// Wire-up: `const finance = createFinance(db)` then `routes.push(...finance.routes)`.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HttpError, type Route } from "./http.ts";

export type IncomeStatus = "pending" | "paid" | "overdue";
export const INCOME_STATUSES: readonly IncomeStatus[] = ["pending", "paid", "overdue"];

export interface Income {
  id: string;
  concept: string;
  clientName: string;
  /** YYYY-MM-DD. */
  date: string;
  amountCents: number;
  currency: string;
  status: IncomeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Cost {
  id: string;
  concept: string;
  category: string;
  monthlyCents: number;
  currency: string;
  /** "<machineId>:<projectId>" keys (ThreadItem.key style); the cost is split evenly across them. */
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export type IncomeInput = Pick<Income, "concept" | "clientName" | "date" | "amountCents" | "currency" | "status">;
export type CostInput = Pick<Cost, "concept" | "category" | "monthlyCents" | "currency" | "projectIds">;

export interface FinanceMonth {
  key: string;
  incomeCents: number;
  costCents: number;
}

export interface FinanceSummary {
  months: FinanceMonth[];
  incomeThisMonth: number;
  fixedCosts: number;
  resultCents: number;
  owedCents: number;
  overdueCount: number;
  /** Rows left out because they use another currency. */
  otherCurrencyRows: number;
}

export interface FinanceView {
  /** The month shown (YYYY-MM), or null for all time. */
  month: string | null;
  currency: string;
  income: Income[];
  costs: Cost[];
  summary: FinanceSummary;
  /** Income per client in `currency` for the shown month, biggest first. */
  byClient: { clientName: string; cents: number }[];
  /** Monthly cost per project in `currency`; projectId null = no project. */
  byProject: { projectId: string | null; cents: number }[];
}

export interface FinanceApi {
  "GET /api/finance": { body: never; res: FinanceView };
  "POST /api/finance/income": { body: IncomeInput; res: Income };
  "PATCH /api/finance/income/:id": { body: Partial<IncomeInput>; res: Income };
  "DELETE /api/finance/income/:id": { body: never; res: { ok: true } };
  "POST /api/finance/costs": { body: CostInput; res: Cost };
  /** archived: true archives, false restores. */
  "PATCH /api/finance/costs/:id": { body: Partial<CostInput> & { archived?: boolean }; res: Cost };
  "DELETE /api/finance/costs/:id": { body: never; res: { ok: true } };
}

// ponytail: augments the HTTP contract from here so types.ts stays untouched; move into Api when convenient.
declare module "./types.ts" {
  interface Api extends FinanceApi {}
}

// ---- pure logic (ported from the fork's finance/logic.ts) ----

export const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** `"12.5"` -> 1250; null for anything that is not a non-negative amount. */
export function parseCents(text: string) {
  const value = Number(text.trim().replace(",", "."));
  if (text.trim() === "" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Totals only make sense in one currency: the one most income rows and active costs use
 * (USD when empty). Archived costs do not vote.
 */
export function displayCurrency(income: readonly Income[], costs: readonly Cost[]) {
  const counts = new Map<string, number>();
  for (const r of [...income, ...costs.filter((c) => c.archivedAt === null)]) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
  let best = "USD";
  let bestCount = 0;
  for (const [currency, n] of counts) if (n > bestCount) [best, bestCount] = [currency, n];
  return best;
}

/** A cost counts in a month when it was created by then and not archived during or before it. */
const costActiveIn = (c: Cost, month: string) =>
  c.createdAt.slice(0, 7) <= month && (c.archivedAt === null || c.archivedAt.slice(0, 7) > month);

/** Monthly cost per project: each active cost splits evenly, leftover cents go to the first projects. */
export function costByProject(costs: readonly Cost[], currency: string) {
  const totals = new Map<string | null, number>();
  const add = (id: string | null, cents: number) => totals.set(id, (totals.get(id) ?? 0) + cents);
  for (const c of costs) {
    if (c.archivedAt !== null || c.currency !== currency) continue;
    const ids = [...new Set(c.projectIds)];
    if (ids.length === 0) {
      add(null, c.monthlyCents);
      continue;
    }
    const share = Math.floor(c.monthlyCents / ids.length);
    const leftover = c.monthlyCents - share * ids.length;
    ids.forEach((id, i) => add(id, share + (i < leftover ? 1 : 0)));
  }
  return totals;
}

const sum = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);

/** KPIs and the six months ending at `now`'s month, in `currency` only. */
export function financeSummary(income: readonly Income[], costs: readonly Cost[], currency: string, now: Date): FinanceSummary {
  const months: FinanceMonth[] = [];
  for (let offset = 5; offset >= 0; offset--) {
    const key = monthKey(new Date(now.getFullYear(), now.getMonth() - offset, 1));
    months.push({
      key,
      incomeCents: sum(income.filter((r) => r.currency === currency && r.date.startsWith(key)), (r) => r.amountCents),
      costCents: sum(costs.filter((c) => c.currency === currency && costActiveIn(c, key)), (c) => c.monthlyCents),
    });
  }
  const unpaid = income.filter((r) => r.currency === currency && r.status !== "paid");
  const incomeThisMonth = months[5]!.incomeCents;
  // Costs active in the month shown (for the current month: the costs active today).
  const fixedCosts = months[5]!.costCents;
  return {
    months,
    incomeThisMonth,
    fixedCosts,
    resultCents: incomeThisMonth - fixedCosts,
    owedCents: sum(unpaid, (r) => r.amountCents),
    overdueCount: unpaid.filter((r) => r.status === "overdue").length,
    otherCurrencyRows: income.filter((r) => r.currency !== currency).length + costs.filter((c) => c.archivedAt === null && c.currency !== currency).length,
  };
}

/** Income per client in `currency`, biggest first (ties by name). */
export function incomeByClient(income: readonly Income[], currency: string) {
  const totals = new Map<string, number>();
  for (const r of income) if (r.currency === currency) totals.set(r.clientName, (totals.get(r.clientName) ?? 0) + r.amountCents);
  return [...totals].map(([clientName, cents]) => ({ clientName, cents })).sort((a, b) => b.cents - a.cents || a.clientName.localeCompare(b.clientName));
}

// ---- storage ----

type Row = Record<string, unknown>;
const toIncome = (r: Row): Income => ({
  id: r.id as string,
  concept: r.concept as string,
  clientName: r.client_name as string,
  date: r.date as string,
  amountCents: r.amount_cents as number,
  currency: r.currency as string,
  status: r.status as IncomeStatus,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});
const toCost = (r: Row): Cost => ({
  id: r.id as string,
  concept: r.concept as string,
  category: r.category as string,
  monthlyCents: r.monthly_cents as number,
  currency: r.currency as string,
  projectIds: JSON.parse(r.project_ids as string) as string[],
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
  archivedAt: (r.archived_at as string | null) ?? null,
});

// ---- validation (trust boundary) ----

const bad = (m: string) => new HttpError(400, "bad_request", m);
const obj = (b: unknown): Row => {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw bad("JSON object body required");
  return b as Row;
};
const text = (v: unknown, name: string, max: number, required: boolean) => {
  if (typeof v !== "string") throw bad(`${name} must be a string`);
  const t = v.trim();
  if (required && !t) throw bad(`${name} is required`);
  if (t.length > max) throw bad(`${name} is too long`);
  return t;
};
const cents = (v: unknown, name: string) => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 1e12) throw bad(`${name} must be a non-negative integer of cents`);
  return v;
};
const currency = (v: unknown) => {
  const c = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(c)) throw bad("currency must be a 3-letter code");
  return c;
};
const date = (v: unknown) => {
  const d = typeof v === "string" ? v : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d) throw bad("date must be YYYY-MM-DD");
  return d;
};
const status = (v: unknown) => {
  if (!INCOME_STATUSES.includes(v as IncomeStatus)) throw bad("status must be pending, paid or overdue");
  return v as IncomeStatus;
};
const projectIds = (v: unknown) => {
  if (!Array.isArray(v) || v.length > 50) throw bad("projectIds must be an array of at most 50 ids");
  return [...new Set(v.map((x) => text(x, "projectId", 200, true)))];
};

/** Validates the keys present in `b`; with `all`, every key is required. */
function incomePatch(b: Row, all: boolean): Partial<IncomeInput> {
  const p: Partial<IncomeInput> = {};
  const has = (k: string) => {
    if (b[k] !== undefined) return true;
    if (all) throw bad(`${k} is required`);
    return false;
  };
  if (has("concept")) p.concept = text(b.concept, "concept", 200, true);
  if (has("clientName")) p.clientName = text(b.clientName, "clientName", 120, false);
  if (has("date")) p.date = date(b.date);
  if (has("amountCents")) p.amountCents = cents(b.amountCents, "amountCents");
  if (has("currency")) p.currency = currency(b.currency);
  if (has("status")) p.status = status(b.status);
  return p;
}
function costPatch(b: Row, all: boolean): Partial<CostInput> {
  const p: Partial<CostInput> = {};
  const has = (k: string) => {
    if (b[k] !== undefined) return true;
    if (all) throw bad(`${k} is required`);
    return false;
  };
  if (has("concept")) p.concept = text(b.concept, "concept", 200, true);
  if (has("category")) p.category = text(b.category, "category", 80, false);
  if (has("monthlyCents")) p.monthlyCents = cents(b.monthlyCents, "monthlyCents");
  if (has("currency")) p.currency = currency(b.currency);
  if (has("projectIds")) p.projectIds = projectIds(b.projectIds);
  return p;
}

export function createFinance(db: DatabaseSync, now: () => Date = () => new Date()) {
  db.exec(`
    create table if not exists cc_income(
      id text primary key,
      concept text not null,
      client_name text not null,
      date text not null,
      amount_cents integer not null,
      currency text not null,
      status text not null,
      created_at text not null,
      updated_at text not null
    );
    create index if not exists cc_income_date on cc_income(date);
    create table if not exists cc_costs(
      id text primary key,
      concept text not null,
      category text not null,
      monthly_cents integer not null,
      currency text not null,
      project_ids text not null,
      created_at text not null,
      updated_at text not null,
      archived_at text
    );
  `);
  const stamp = () => now().toISOString();
  const allIncome = () => (db.prepare("select * from cc_income order by date desc, created_at desc").all() as Row[]).map(toIncome);
  const allCosts = () => (db.prepare("select * from cc_costs order by created_at, rowid").all() as Row[]).map(toCost);
  const getIncome = (id: string) => {
    const r = db.prepare("select * from cc_income where id = ?").get(id) as Row | undefined;
    if (!r) throw new HttpError(404, "not_found", "Income not found");
    return toIncome(r);
  };
  const getCost = (id: string) => {
    const r = db.prepare("select * from cc_costs where id = ?").get(id) as Row | undefined;
    if (!r) throw new HttpError(404, "not_found", "Cost not found");
    return toCost(r);
  };

  /** month = YYYY-MM filters the income list, the client totals and the summary window; null = all time. */
  function view(month: string | null): FinanceView {
    const inc = allIncome();
    const costs = allCosts();
    const cur = displayCurrency(inc, costs);
    const shown = month ? inc.filter((r) => r.date.startsWith(month)) : inc;
    const end = month ? new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1) : now();
    return {
      month,
      currency: cur,
      income: shown,
      costs,
      summary: financeSummary(inc, costs, cur, end),
      byClient: incomeByClient(shown, cur),
      byProject: [...costByProject(costs, cur)].map(([projectId, c]) => ({ projectId, cents: c })).sort((a, b) => b.cents - a.cents),
    };
  }

  function addIncome(input: unknown): Income {
    const p = incomePatch(obj(input), true) as IncomeInput;
    const t = stamp();
    const id = randomUUID();
    db.prepare("insert into cc_income(id, concept, client_name, date, amount_cents, currency, status, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)").run(
      id, p.concept, p.clientName, p.date, p.amountCents, p.currency, p.status, t, t,
    );
    return getIncome(id);
  }
  function updateIncome(id: string, input: unknown): Income {
    const n = { ...getIncome(id), ...incomePatch(obj(input), false) };
    db.prepare("update cc_income set concept=?, client_name=?, date=?, amount_cents=?, currency=?, status=?, updated_at=? where id=?").run(
      n.concept, n.clientName, n.date, n.amountCents, n.currency, n.status, stamp(), id,
    );
    return getIncome(id);
  }
  function addCost(input: unknown): Cost {
    const p = costPatch(obj(input), true) as CostInput;
    const t = stamp();
    const id = randomUUID();
    db.prepare("insert into cc_costs(id, concept, category, monthly_cents, currency, project_ids, created_at, updated_at) values (?,?,?,?,?,?,?,?)").run(
      id, p.concept, p.category, p.monthlyCents, p.currency, JSON.stringify(p.projectIds), t, t,
    );
    return getCost(id);
  }
  function updateCost(id: string, input: unknown): Cost {
    const b = obj(input);
    const cur = getCost(id);
    const n = { ...cur, ...costPatch(b, false) };
    let archivedAt = cur.archivedAt;
    if (b.archived !== undefined) {
      if (typeof b.archived !== "boolean") throw bad("archived must be a boolean");
      archivedAt = b.archived ? (cur.archivedAt ?? stamp()) : null;
    }
    db.prepare("update cc_costs set concept=?, category=?, monthly_cents=?, currency=?, project_ids=?, archived_at=?, updated_at=? where id=?").run(
      n.concept, n.category, n.monthlyCents, n.currency, JSON.stringify(n.projectIds), archivedAt, stamp(), id,
    );
    return getCost(id);
  }
  const remove = (table: "cc_income" | "cc_costs", id: string) => {
    if (db.prepare(`delete from ${table} where id = ?`).run(id).changes === 0) throw new HttpError(404, "not_found", "Not found");
    return { ok: true };
  };

  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/finance",
      auth: "cookie",
      handler: ({ url }) => {
        const m = url.searchParams.get("month");
        if (m !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw bad("month must be YYYY-MM");
        return view(m);
      },
    },
    { method: "POST", path: "/api/finance/income", auth: "cookie", handler: ({ body }) => addIncome(body) },
    { method: "PATCH", path: "/api/finance/income/:id", auth: "cookie", handler: ({ params, body }) => updateIncome(params.id!, body) },
    { method: "DELETE", path: "/api/finance/income/:id", auth: "cookie", handler: ({ params }) => remove("cc_income", params.id!) },
    { method: "POST", path: "/api/finance/costs", auth: "cookie", handler: ({ body }) => addCost(body) },
    { method: "PATCH", path: "/api/finance/costs/:id", auth: "cookie", handler: ({ params, body }) => updateCost(params.id!, body) },
    { method: "DELETE", path: "/api/finance/costs/:id", auth: "cookie", handler: ({ params }) => remove("cc_costs", params.id!) },
  ];

  return { routes, view, addIncome, updateIncome, addCost, updateCost };
}
