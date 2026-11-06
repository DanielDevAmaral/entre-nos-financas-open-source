import { asUser, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { economicEffect, type Currency, type Kind } from "../domain/finance.ts";
export type HistoryMonth = {
  month: string;
  income_cents: string;
  expense_cents: string;
  planned_income_cents: string;
  planned_commitments_cents: string;
  unknown_planned: number;
  investment_flows: { kind: string; amount_cents: string }[];
  categories: { name: string; spent_cents: string }[];
};
/** Authorized aggregates only: no counterparties, raw descriptions, account credentials or generated SQL. */
export async function readHelpHistory(
  db: Database,
  user: Identity,
  currency: Currency,
): Promise<HistoryMonth[]> {
  return asUser(db, user.userId, async (tx) => {
    const events = (
      await tx.query<{
        month: string;
        kind: Kind;
        category: string | null;
        amount: string;
      }>(
        `SELECT to_char(e.transaction_date,'YYYY-MM') AS month,e.kind,c.name AS category,sum(e.amount_cents)::text AS amount FROM economic_events e LEFT JOIN categories c ON c.id=e.category_id AND c.household_id=e.household_id WHERE e.household_id=$1 AND e.currency=$2 GROUP BY 1,2,3 ORDER BY 1`,
        [user.familyId, currency],
      )
    ).rows;
    const plans = (
      await tx.query<{
        month: string;
        income: string;
        commitments: string;
        unknown: number;
      }>(
        `SELECT to_char(month,'YYYY-MM') AS month,coalesce(sum(planned_cents) FILTER(WHERE purpose='income'),0)::text AS income,coalesce(sum(planned_cents) FILTER(WHERE purpose<>'income'),0)::text AS commitments,count(*) FILTER(WHERE planned_cents IS NULL)::int AS unknown FROM monthly_items WHERE household_id=$1 AND currency=$2 GROUP BY 1 ORDER BY 1`,
        [user.familyId, currency],
      )
    ).rows;
    const months = new Map<string, HistoryMonth>();
    const month = (key: string) => {
      if (!months.has(key))
        months.set(key, {
          month: key,
          income_cents: "0",
          expense_cents: "0",
          planned_income_cents: "0",
          planned_commitments_cents: "0",
          unknown_planned: 0,
          investment_flows: [],
          categories: [],
        });
      return months.get(key)!;
    };
    for (const p of plans)
      Object.assign(month(p.month), {
        planned_income_cents: p.income,
        planned_commitments_cents: p.commitments,
        unknown_planned: p.unknown,
      });
    for (const e of events) {
      const m = month(e.month),
        effect = economicEffect(e.kind, BigInt(e.amount));
      m.income_cents = (BigInt(m.income_cents) + effect.income).toString();
      m.expense_cents = (BigInt(m.expense_cents) + effect.expense).toString();
      if (["investment_buy", "investment_sell", "yield"].includes(e.kind)) {
        const prior = m.investment_flows.find((flow) => flow.kind === e.kind);
        if (prior)
          prior.amount_cents = (
            BigInt(prior.amount_cents) + BigInt(e.amount)
          ).toString();
        else m.investment_flows.push({ kind: e.kind, amount_cents: e.amount });
      }
      if (effect.expense !== 0n) {
        const name = e.category ?? "Sem categoria";
        const prior = m.categories.find((c) => c.name === name);
        if (prior)
          prior.spent_cents = (
            BigInt(prior.spent_cents) + effect.expense
          ).toString();
        else
          m.categories.push({ name, spent_cents: effect.expense.toString() });
      }
    }
    return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
  });
}
