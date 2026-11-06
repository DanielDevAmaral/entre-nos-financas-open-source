import type { HelpContext } from "./help.ts";

// Structured RAG: retrieve bounded facts from the authorized database snapshot.
// No generated SQL, document upload, vector service or model-computed money.
export function retrieveFacts(question: string, c: HelpContext) {
  const q = question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const items = c.items.filter((i) => i.currency === c.currency);
  const sum = (rows: typeof items) =>
    rows.reduce((s, i) => s + BigInt(i.planned_cents ?? "0"), 0n);
  const facts: { id: string; label: string; data: Record<string, unknown> }[] =
    [];
  if (c.historyMonths) {
    const categoryTerms = q.split(/\W+/).filter((t) => t.length >= 4);
    facts.push({
      id: "T1",
      label: "Histórico da família em todos os meses disponíveis",
      data: {
        monthly_totals: c.historyMonths.map(({ categories, ...month }) => ({
          ...month,
          relevant_categories: categories.filter((category) =>
            categoryTerms.some((term) =>
              category.name
                .normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()
                .includes(term),
            ),
          ),
        })),
        confirmed_only: true,
        own_transfers_fx_principal_and_invoice_payments_excluded: true,
        missing_month_is_not_zero: true,
        not_a_bank_balance: true,
      },
    });
  }
  if (c.bankReviewCount !== undefined && /banc|cruzamento|duplic|revis/.test(q))
    facts.push({
      id: "B1",
      label: "Revisão bancária",
      data: {
        pending_bank_observations: c.bankReviewCount ?? 0,
        not_in_confirmed_totals: true,
      },
    });
  const food = /alimenta|mercado|comida|feira/.test(q);
  const investment = /invest|reserv|aplic|resgat|rendiment/.test(q);
  const bills = /conta|pagar|venc|penden|atras/.test(q);
  const history = /gast|consumo|receb|entrou|entrada|historico/.test(q);
  const plan =
    /plano|planej|sobra|guardar|disponivel/.test(q) ||
    (!food && !investment && !bills && !history);
  if (
    /salario|wise|wize|financia|entrada|receb/.test(q) &&
    items.some((i) => i.funding)
  ) {
    facts.push({
      id: "R1",
      label: "Recebimentos que financiam o mês",
      data: {
        expected_receipts: items
          .filter((i) => i.funding)
          .map((i) => ({
            expected_date: i.funding!.expected_date,
            bank_received_date: i.funding!.received_date,
            review_state: i.funding!.state,
            budget_month: c.month,
            not_confirmed_income: true,
          })),
        no_raw_bank_descriptions: true,
      },
    });
  }
  if (plan) {
    const incoming = sum(items.filter((i) => i.purpose === "income")),
      outgoing = sum(items.filter((i) => i.purpose !== "income"));
    facts.push({
      id: "P1",
      label: "Planejamento mensal",
      data: {
        planned_income_cents: incoming.toString(),
        planned_commitments_cents: outgoing.toString(),
        planned_difference_cents: (incoming - outgoing).toString(),
        unknown_planned_values: items.some((i) => i.planned_cents === null),
        not_a_bank_balance: true,
      },
    });
  }
  if (bills) {
    const open = items.filter(
      (i) => i.purpose !== "income" && i.status !== "done",
    );
    facts.push({
      id: "C1",
      label: "Compromissos em aberto",
      data: {
        count: open.length,
        known_remaining_cents: open
          .reduce((s, i) => {
            const n =
              BigInt(i.planned_cents ?? "0") - BigInt(i.paid_cents ?? "0");
            return s + (n > 0n ? n : 0n);
          }, 0n)
          .toString(),
        unknown_amounts: open.filter((i) => i.planned_cents === null).length,
        without_due_date: open.filter((i) => !i.due_date).length,
        due_until_today_count: open.filter(
          (i) => i.due_date && i.due_date <= c.today,
        ).length,
        as_of_date: c.today,
        individual_details_omitted: true,
      },
    });
  }
  if (food) {
    const rows = c.budgets.filter((b) =>
      /alimenta|supermerc|feira/.test(
        b.category_name
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase(),
      ),
    );
    const total = (key: "planned_cents" | "spent_cents" | "remaining_cents") =>
      rows.reduce((s, r) => s + BigInt(r[key]), 0n).toString();
    facts.push({
      id: "A1",
      label: "Orçamento de alimentação",
      data: {
        available: rows.length > 0,
        planned_cents: total("planned_cents"),
        confirmed_spent_cents: total("spent_cents"),
        remaining_cents: total("remaining_cents"),
        partial_history: true,
      },
    });
  }
  if (investment)
    facts.push({
      id: "I1",
      label: "Movimentações de investimentos",
      data: {
        movements: (c.investmentMovements ?? [])
          .filter((r) => r.currency === c.currency)
          .map(({ kind, amount_cents }) => ({ kind, amount_cents })),
        not_current_portfolio_value: true,
        yields_may_include_checking_accounts: true,
      },
    });
  if (history || (!food && !investment && !bills))
    facts.push({
      id: "H1",
      label: "Movimentos confirmados",
      data: {
        income_cents: c.income_cents,
        consumption_cents: c.expense_cents,
        own_transfers_and_fx_principal_excluded: true,
      },
    });
  return {
    period: c.month,
    currency: c.currency,
    unit: "integer cents",
    unresolved_movements: c.unresolved,
    coverage:
      "Confirmed events and planning in the authorized family history, with monthly details for the question's reference period. Not proof of complete history. Missing months and unknown amounts are not zero-valued evidence. No real-time balances or market prices.",
    facts,
  };
}
