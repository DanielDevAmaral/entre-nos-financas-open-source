import { test } from "node:test";
import assert from "node:assert/strict";
import {
  movementTotals,
  visibleMovements,
  type Movement,
} from "../src/domain/movements.ts";
const row = (
  id: string,
  kind: string | null,
  amount: string,
  extra: Partial<Movement> = {},
): Movement => ({
  id,
  kind,
  amount,
  date: "2026-10-24",
  description: "Mercado São João",
  account: "Nubank",
  category: "Alimentação",
  review: false,
  duplicate: false,
  ...extra,
});
test("movement totals exclude previews, internal transfers and invoice payments; purchases counted only once", () => {
  const totals = movementTotals([
    row("1", "income", "100000"),
    row("2", "expense", "-3000"),
    row("3", "card_purchase", "-2000"),
    row("4", "card_payment", "-2000"),
    row("5", "transfer", "-40000"),
    row("6", "refund", "500"),
    row("7", null, "900000", { review: true }),
    row("8", "expense", "-99999", { review: true }),
  ]);
  assert.deepEqual(totals, {
    income: "100000",
    expense: "4500",
    transfers: 1,
    review: 2,
  });
});
test("movement search matches account, category and accent-insensitive words; review never classified from sign", () => {
  const rows = [
    row("older", "expense", "-1", { date: "2026-10-01" }),
    row("newer", null, "500", { review: true }),
    row("itau", "income", "400", { account: "Itaú", date: "2026-10-25" }),
  ];
  assert.equal(visibleMovements(rows, "itau", "income", "")[0].id, "itau");
  assert.equal(
    visibleMovements(rows, "alimentacao sao", "review", "Nubank")[0].id,
    "newer",
  );
  assert.equal(visibleMovements(rows, "", "income", "Nubank").length, 0);
  assert.deepEqual(
    visibleMovements(rows, "", "all", "").map((r) => r.id),
    ["itau", "newer", "older"],
  );
});
