import assert from "node:assert/strict";
import test from "node:test";
import { financeAmount } from "./financeValidation.ts";
import { money } from "./financeView.ts";

test("importes decimales se convierten a centavos dentro del l\u00edmite del servicio", () => {
  for (const [input, cents] of [["0", 0], ["12,34", 1234], [" 12.5 ", 1250], [".01", 1], ["0.29", 29], ["10000000000", 1e12]] as const) {
    assert.equal(financeAmount(input), cents);
  }
});

test("se rechazan importes ambiguos, negativos, infinitos o fuera de l\u00edmites", () => {
  for (const value of ["", " ", "-1", "1,234", "1.234", "1.000,00", "1e4", "0x10", "Infinity", "NaN", "10000000000.01", "9007199254740992", "1 000"]) {
    assert.equal(financeAmount(value), null, value);
  }
});

test("la privacidad enmascara tambi\u00e9n los valores accesibles de cada mes", () => {
  for (const amount of [0, 1, 150000, 1e12]) {
    assert.equal(money(amount, "USD", true), "\u2022\u2022\u2022\u2022");
    assert.notEqual(money(amount, "USD", false), money(amount, "USD", true));
  }
});
