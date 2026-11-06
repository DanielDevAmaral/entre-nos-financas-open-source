type CardOverviewInput = {
  id: string;
  name: string;
  manual_bill: { amount_cents: string; due_date: string; paid: boolean } | null;
  bills: {
    total_cents: string | null;
    needs_review: boolean;
    due_date: string;
  }[];
  projection: {
    total_cents: string;
    due_date: string;
    needs_review: boolean;
  } | null;
};
/** Exactly one source per card: bank invoice, explicit family invoice, then estimate. Never add purchases or limits. */
export function cardOverview(cards: CardOverviewInput[]) {
  const rows = cards.map((c) => {
    let amount: string | null = null,
      source = "A conferir",
      due: string | null = null;
    if (c.bills.length) {
      if (c.bills.every((b) => !b.needs_review && b.total_cents !== null)) {
        amount = c.bills
          .reduce((n, b) => n + BigInt(b.total_cents!), 0n)
          .toString();
        source = "Fatura do banco";
        due = c.bills.map((b) => b.due_date).sort()[0];
      }
    } else if (c.manual_bill) {
      amount = c.manual_bill.amount_cents;
      source = c.manual_bill.paid
        ? "Fatura informada · paga"
        : "Fatura informada";
      due = c.manual_bill.due_date;
    } else if (c.projection && !c.projection.needs_review) {
      amount = c.projection.total_cents;
      source = "Estimativa";
      due = c.projection.due_date;
    }
    return {
      id: c.id,
      name: c.name,
      amount_cents: amount,
      source,
      due_date: due,
    };
  });
  const total = rows.reduce((n, r) => n + BigInt(r.amount_cents ?? "0"), 0n);
  return {
    total_cents: total.toString(),
    unknown: rows.filter((r) => r.amount_cents === null).length,
    hasEstimates: rows.some((r) => r.source === "Estimativa"),
    rows: rows.map((r) => ({
      ...r,
      share:
        total > 0n
          ? Number((BigInt(r.amount_cents ?? "0") * 10000n) / total) / 100
          : 0,
    })),
  };
}
