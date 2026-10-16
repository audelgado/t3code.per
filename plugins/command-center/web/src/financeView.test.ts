import assert from "node:assert/strict";
import test from "node:test";
import { NEXT_STATUS, dayLabel, money, monthLabel, toCents } from "./financeView.ts";

test("amounts accept a dot or a comma and reject anything else", () => {
  assert.equal(toCents("12.5"), 1250);
  assert.equal(toCents(" 12,5 "), 1250);
  assert.equal(toCents("0"), 0);
  for (const bad of ["", "  ", "-1", "abc", "1,2,3"]) assert.equal(toCents(bad), null);
});

test("money is es-AR, hides on request and survives a bad currency code", () => {
  assert.match(money(1240000, "ARS", false), /12\.400/);
  assert.match(money(1250, "ARS", false), /12,50/);
  assert.equal(money(1240000, "ARS", true), "••••");
  assert.match(money(500, "??", false), /5/);
});

test("dates are short es-AR labels", () => {
  assert.equal(monthLabel("2026-10"), "oct");
  assert.equal(dayLabel("2026-10-05"), "5 oct");
});

test("the status chip cycles pending, paid, overdue", () => {
  assert.equal(NEXT_STATUS.pending, "paid");
  assert.equal(NEXT_STATUS.paid, "overdue");
  assert.equal(NEXT_STATUS.overdue, "pending");
});
