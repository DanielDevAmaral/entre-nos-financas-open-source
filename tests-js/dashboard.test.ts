import { test } from "node:test";
import assert from "node:assert/strict";
import { planGroup, categorySpending } from "../src/domain/dashboard.ts";
import { openDatabase } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { saveItem, readRoutine, copyMonth } from "../src/server/routine.ts";

test("plan groups keep income and savings separate and respect explicit choices", () => {
  assert.equal(
    planGroup({
      purpose: "income",
      label: "Aluguel recebido",
      cost_type: "fixed",
    }),
    "income",
  );
  assert.equal(planGroup({ purpose: "saving", label: "Reserva" }), "saving");
  assert.equal(planGroup({ purpose: "expense", label: "Água" }), "fixed");
  assert.equal(planGroup({ purpose: "expense", label: "Mercado" }), "variable");
  assert.equal(
    planGroup({ purpose: "expense", label: "Internet", cost_type: "variable" }),
    "variable",
  );
  assert.equal(planGroup({ purpose: "card", label: "Fatura" }), "variable");
});
test("pie counts consumption once, nets refunds, includes uncategorized and excludes own movements", () => {
  const base = { category_id: "food", category_name: "Alimentação" };
  const chart = categorySpending([
    { ...base, kind: "expense", amount_cents: "-10000" },
    { ...base, kind: "card_purchase", amount_cents: "-5000" },
    { ...base, kind: "refund", amount_cents: "2000" },
    { ...base, kind: "card_payment", amount_cents: "-5000" },
    { ...base, kind: "transfer", amount_cents: "-80000" },
    { ...base, kind: "fx", amount_cents: "-100000" },
    { ...base, kind: "investment_buy", amount_cents: "-40000" },
    { ...base, kind: "income", amount_cents: "300000" },
    {
      category_id: null,
      category_name: null,
      kind: "fee",
      amount_cents: "-130",
    },
    {
      category_id: "travel",
      category_name: "Viagem",
      kind: "refund",
      amount_cents: "2500",
    },
  ]);
  assert.equal(chart.total, 13130n);
  assert.equal(chart.slices[0].cents, 13000n);
  assert.equal(chart.slices[1].name, "Sem categoria");
  assert.equal(chart.adjustments[0].cents, -2500n);
  assert.deepEqual(categorySpending([]), {
    slices: [],
    adjustments: [],
    total: 0n,
  });
});
test("cost classification persists, survives omitted-field edits and copies without changing money", async () => {
  const db = await openDatabase();
  try {
    const userId = await createFamily(db, {
      name: "Teste",
      familyName: "Casa",
      email: "dashboard@example.invalid",
      password: "SenhaSintetica!2026",
    });
    const familyId = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [userId],
      )
    ).rows[0].household_id;
    const user = {
      userId,
      familyId,
      name: "Teste",
      email: "dashboard@example.invalid",
      role: "owner",
    } as Identity;
    const input = {
      month: "2026-10",
      label: "Mercado",
      purpose: "expense",
      currency: "BRL",
      amount: "123,45",
      due_date: null,
    };
    const { id } = await saveItem(db, user, { ...input, cost_type: "fixed" });
    await saveItem(db, user, {
      ...input,
      id,
      version: 1,
      label: "Mercado da casa",
    });
    const item = (await readRoutine(db, user, "2026-10")).items[0];
    assert.equal(item.cost_type, "fixed");
    assert.equal(item.planned_cents, "12345");
    await assert.rejects(
      saveItem(db, user, { ...input, id, version: 1, cost_type: "variable" }),
    );
    await assert.rejects(
      saveItem(db, user, { ...input, cost_type: "invalid" }),
    );
    await copyMonth(db, user, { from: "2026-10", to: "2026-11" });
    assert.equal(
      (await readRoutine(db, user, "2026-11")).items[0].cost_type,
      "fixed",
    );
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
