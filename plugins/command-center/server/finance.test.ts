import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "./db.ts";
import { HttpError } from "./http.ts";
import { costByProject, createFinance, displayCurrency, financeSummary, incomeByClient, parseCents, type Cost, type Income } from "./finance.ts";

const cost = (id: string, monthlyCents: number, projectIds: string[], extra: Partial<Cost> = {}): Cost => ({
  id, concept: id, category: "", monthlyCents, currency: "USD", projectIds,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", archivedAt: null, ...extra,
});
const inc = (id: string, date: string, amountCents: number, status: Income["status"], clientName = "Client"): Income => ({
  id, concept: id, clientName, date, amountCents, currency: "USD", status,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

test("costByProject splits evenly, keeps every cent, skips archived and other currencies", () => {
  const t = costByProject(
    [
      cost("vps", 1000, ["a", "b", "c"]),
      cost("domain", 500, ["a"]),
      cost("tools", 300, []),
      cost("old", 9999, ["a"], { archivedAt: "2026-02-01T00:00:00.000Z" }),
      cost("eur", 9999, ["a"], { currency: "EUR" }),
    ],
    "USD",
  );
  assert.equal(t.get("a"), 334 + 500);
  assert.equal(t.get("b"), 333);
  assert.equal(t.get("c"), 333);
  assert.equal(t.get(null), 300);
});

test("financeSummary totals the current month and the six-month history", () => {
  const s = financeSummary(
    [inc("oct-paid", "2026-10-02", 5000, "paid"), inc("oct-pending", "2026-10-20", 2000, "pending"), inc("sep-overdue", "2026-09-15", 1000, "overdue")],
    [
      cost("vps", 1500, ["a"]),
      cost("archived-aug", 700, ["a"], { archivedAt: "2026-08-10T00:00:00.000Z" }),
      cost("new-oct", 100, [], { createdAt: "2026-10-05T00:00:00.000Z" }),
    ],
    "USD",
    new Date(2026, 9, 13),
  );
  assert.equal(s.incomeThisMonth, 7000);
  assert.equal(s.fixedCosts, 1600);
  assert.equal(s.resultCents, 5400);
  assert.equal(s.owedCents, 3000);
  assert.equal(s.overdueCount, 1);
  assert.deepEqual(s.months.map((m) => m.key), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(s.months.map((m) => m.costCents), [2200, 2200, 2200, 1500, 1500, 1600]);
  assert.equal(s.months[4]!.incomeCents, 1000);

  // Viewing August: the October cost is not there yet and the cost archived in August no longer counts.
  const aug = financeSummary([inc("aug", "2026-08-03", 3000, "paid")], [cost("vps", 1500, ["a"]), cost("new-oct", 100, [], { createdAt: "2026-10-05T00:00:00.000Z" }), cost("archived-aug", 700, ["a"], { archivedAt: "2026-08-10T00:00:00.000Z" })], "USD", new Date(2026, 7, 1));
  assert.deepEqual([aug.fixedCosts, aug.resultCents], [1500, 1500]);
});

test("displayCurrency ignores archived costs", () => {
  const archived = { currency: "EUR", archivedAt: "2026-08-10T00:00:00.000Z" };
  assert.equal(displayCurrency([inc("a", "2026-10-01", 5, "pending"), inc("b", "2026-10-02", 5, "pending")], [cost("x", 1, [], archived), cost("y", 1, [], archived), cost("z", 1, [], archived)]), "USD");
  assert.equal(displayCurrency([], [cost("eur", 100, [], { currency: "EUR" })]), "EUR");
});

test("parseCents accepts dot or comma decimals and rejects junk", () => {
  assert.equal(parseCents("12.5"), 1250);
  assert.equal(parseCents("0,99"), 99);
  assert.equal(parseCents(""), null);
  assert.equal(parseCents("-1"), null);
  assert.equal(parseCents("abc"), null);
});

test("incomeByClient sums per client, biggest first", () => {
  assert.deepEqual(incomeByClient([inc("1", "2026-10-01", 100, "paid", "B"), inc("2", "2026-10-02", 300, "paid", "A"), inc("3", "2026-10-03", 250, "paid", "B")], "USD"), [
    { clientName: "B", cents: 350 },
    { clientName: "A", cents: 300 },
  ]);
});

function setup(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "cc-fin-"));
  const db = openDb(home);
  t.after(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });
  return createFinance(db, () => new Date(2026, 9, 13, 12));
}
const throws = (fn: () => unknown, status: number) => assert.throws(fn, (e) => e instanceof HttpError && e.status === status);
const base = { concept: "Site", clientName: "Acme", date: "2026-10-02", amountCents: 5000, currency: "usd", status: "pending" };

test("income CRUD validates input and normalises currency", (t) => {
  const f = setup(t);
  const a = f.addIncome(base);
  assert.equal(a.currency, "USD");
  assert.equal(f.updateIncome(a.id, { status: "paid" }).status, "paid");
  assert.equal(f.updateIncome(a.id, { amountCents: 7000 }).clientName, "Acme");
  throws(() => f.addIncome({ ...base, amountCents: 1.5 }), 400);
  throws(() => f.addIncome({ ...base, date: "2026-02-31" }), 400);
  throws(() => f.addIncome({ ...base, status: "nope" }), 400);
  throws(() => f.addIncome({ concept: "x" }), 400);
  throws(() => f.updateIncome("missing", {}), 404);
  const del = f.routes.find((r) => r.method === "DELETE" && r.path.includes("income"))!;
  const ctx = { params: { id: a.id } } as never;
  assert.deepEqual(del.handler(ctx), { ok: true });
  throws(() => del.handler(ctx), 404);
});

test("costs archive and restore; month filter drives lists, client totals and summary window", (t) => {
  const f = setup(t);
  f.addIncome(base);
  f.addIncome({ ...base, date: "2026-09-10", amountCents: 1000, clientName: "Beta" });
  const c = f.addCost({ concept: "VPS", category: "Infra", monthlyCents: 1500, currency: "USD", projectIds: ["m:p1", "m:p1", "m:p2"] });
  assert.deepEqual(c.projectIds, ["m:p1", "m:p2"]);

  let v = f.view(null);
  assert.equal(v.income.length, 2);
  assert.equal(v.summary.incomeThisMonth, 5000);
  assert.deepEqual(v.byProject, [{ projectId: "m:p1", cents: 750 }, { projectId: "m:p2", cents: 750 }]);

  v = f.view("2026-09");
  assert.deepEqual(v.income.map((r) => r.clientName), ["Beta"]);
  assert.deepEqual(v.byClient, [{ clientName: "Beta", cents: 1000 }]);
  assert.equal(v.summary.incomeThisMonth, 1000);
  assert.equal(v.summary.months[5]!.key, "2026-09");

  assert.ok(f.updateCost(c.id, { archived: true }).archivedAt);
  assert.equal(f.view(null).summary.fixedCosts, 0);
  assert.equal(f.updateCost(c.id, { archived: false }).archivedAt, null);
  throws(() => f.updateCost(c.id, { archived: "yes" }), 400);
  throws(() => f.addCost({ concept: "x", category: "", monthlyCents: -1, currency: "USD", projectIds: [] }), 400);
});

test("GET /api/finance rejects a malformed month", (t) => {
  const f = setup(t);
  const get = f.routes.find((r) => r.method === "GET")!;
  throws(() => get.handler({ url: new URL("http://cc/api/finance?month=2026-13") } as never), 400);
  assert.equal((get.handler({ url: new URL("http://cc/api/finance?month=2026-10") } as never) as { month: string }).month, "2026-10");
});
