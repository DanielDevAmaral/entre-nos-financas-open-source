import { test } from "node:test";
import assert from "node:assert/strict";
import { cardOverview } from "../src/domain/card-overview.ts";

test("card chart uses one source per card and never adds limits, purchases or estimates over an official bill", () => {
  const projection = {
    total_cents: "99999",
    due_date: "2026-11-03",
    needs_review: false,
  };
  const result = cardOverview([
    {
      id: "bank",
      name: "Banco A",
      bills: [
        { total_cents: "12000", due_date: "2026-11-03", needs_review: false },
      ],
      manual_bill: {
        amount_cents: "88888",
        due_date: "2026-11-03",
        paid: false,
      },
      projection,
    },
    {
      id: "manual",
      name: "Banco B",
      bills: [],
      manual_bill: {
        amount_cents: "42000",
        due_date: "2026-11-15",
        paid: false,
      },
      projection,
    },
    {
      id: "estimate",
      name: "Banco C",
      bills: [],
      manual_bill: null,
      projection: { ...projection, total_cents: "7107" },
    },
  ]);
  assert.equal(result.total_cents, "61107");
  assert.deepEqual(
    result.rows.map((r) => r.amount_cents),
    ["12000", "42000", "7107"],
  );
  assert.equal(result.unknown, 0);
  assert.equal(result.hasEstimates, true);
  assert.ok(result.rows.every((r) => r.share >= 0 && r.share <= 100));
});

test("missing and disputed bills remain unknown rather than becoming zero or falling back to an unconfirmed estimate", () => {
  const base = {
    id: "unknown",
    name: "Banco fictício",
    bills: [],
    manual_bill: null,
    projection: null,
  };
  const result = cardOverview([
    base,
    {
      ...base,
      id: "review",
      bills: [
        { total_cents: null, due_date: "2026-11-03", needs_review: true },
      ],
      projection: {
        total_cents: "10000",
        due_date: "2026-11-03",
        needs_review: false,
      },
    },
    {
      ...base,
      id: "cycle",
      projection: {
        total_cents: "10000",
        due_date: "2026-11-03",
        needs_review: true,
      },
    },
  ]);
  assert.equal(result.unknown, 3);
  assert.equal(result.total_cents, "0");
  assert.ok(result.rows.every((r) => r.amount_cents === null && r.share === 0));
});
