import type { MonthlyItem } from "../server/routine.ts";
import { formatted, brDate } from "./format.ts";
import type { Currency } from "./finance.ts";
import type { HistoryMonth } from "../server/help-history.ts";

export type HelpContext = {
  month: string;
  historyMonths?: HistoryMonth[];
  currency: Currency;
  today: string;
  items: MonthlyItem[];
  income_cents: string;
  expense_cents: string;
  unresolved: number;
  bankReviewCount?: number;
  investmentMovements?: {
    kind: string;
    currency: string;
    amount_cents: string;
  }[];
  budgets: {
    category_name: string;
    planned_cents: string;
    spent_cents: string;
    remaining_cents: string;
  }[];
};
const normalize = (v: string) =>
  v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
export function localHelp(question: string, context: HelpContext) {
  const q = normalize(question),
    c = context,
    m = (n: bigint | string) => formatted(String(n), c.currency);
  if (c.historyMonths && /compar|historico|meses|ano|evolu|ao longo/.test(q)) {
    const year = q.match(/\b20\d{2}\b/)?.[0];
    const rows = c.historyMonths.filter(
      (row) => !year || row.month.startsWith(year),
    );
    return {
      text: rows.length
        ? rows
            .map(
              (row) =>
                `${row.month}: entradas confirmadas de ${m(row.income_cents)}; consumo de ${m(row.expense_cents)}. Plano: ${m(row.planned_income_cents)} de entradas e ${m(row.planned_commitments_cents)} de compromissos${row.unknown_planned ? " (há valores a definir)" : ""}.`,
            )
            .join("\n")
        : "Não há meses com registros disponíveis para esse período.",
      source: `Judite · histórico da família · ${c.currency}`,
      coverage:
        "Meses sem registros não são presumidos zerados. Transferências e pagamentos de fatura não são novos gastos; previsões não são receitas confirmadas. Histórico parcial não comprova saldo bancário.",
      mode: "local" as const,
    };
  }
  const items = c.items.filter((i) => i.currency === c.currency);
  const open = items.filter(
    (i) => i.purpose !== "income" && i.status !== "done",
  );
  const remainder = (i: MonthlyItem) => {
    const n = BigInt(i.planned_cents ?? "0") - BigInt(i.paid_cents ?? "0");
    return n > 0n ? n : 0n;
  };
  const sum = (list: MonthlyItem[]) =>
    list.reduce((s, i) => s + BigInt(i.planned_cents ?? "0"), 0n);
  const planned = sum(items.filter((i) => i.purpose !== "income")),
    income = sum(items.filter((i) => i.purpose === "income"));
  let text: string;
  if (/salario|wise|wize|financia/.test(q) && items.some((i) => i.funding)) {
    text =
      items
        .filter((i) => i.funding)
        .map(
          (i) =>
            `${i.label}: ${i.funding!.received_date ? "crédito identificado em " + brDate(i.funding!.received_date) : "recebimento previsto em " + brDate(i.funding!.expected_date)} para financiar o planejamento de ${c.month}. ${i.funding!.note}`,
        )
        .join("\n") +
      "\nIdentificação bancária e previsão não confirmam receita nem aumentam os totais realizados.";
  } else if (/cambio|transfer|fatura/.test(q))
    text =
      "Transferências entre suas contas e o principal do câmbio não são renda ou consumo. A tarifa do câmbio é um custo separado. Pagar a fatura quita uma obrigação; as compras do cartão representam o consumo. Movimentos sem finalidade comprovada permanecem fora dos totais.";
  else if (/invest|reserv|rendiment|aplic|resgat/.test(q)) {
    const rows =
      c.investmentMovements?.filter((r) => r.currency === c.currency) ?? [];
    text =
      (rows.length
        ? rows
            .map(
              (r) =>
                `${({ investment_buy: "Aportes", investment_sell: "Resgates", yield: "Rendimentos registrados" } as Record<string, string>)[r.kind]}: ${m(r.amount_cents)}.`,
            )
            .join("\n")
        : "Não há aportes, resgates ou rendimentos confirmados neste mês e moeda.") +
      "\nEm Futuro, vocês encontram as posições conhecidas. As moedas são separadas. Esses movimentos não comprovam saldo atual ou rentabilidade da carteira; rendimentos podem incluir contas correntes.";
  } else if (/aliment|mercado|categoria/.test(q)) {
    const wanted = c.budgets.filter((b) =>
      /alimenta|supermerc|feira/.test(normalize(b.category_name)),
    );
    text = wanted.length
      ? wanted
          .map(
            (b) =>
              `${b.category_name}: ${m(b.spent_cents)} de consumo confirmado para ${m(b.planned_cents)} planejados; diferença de ${m(b.remaining_cents)}.`,
          )
          .join("\n")
      : "Não há orçamento de alimentação nesta moeda para este mês. Vocês podem ajustar as contas no planejamento; não vou estimar um limite sem dados.";
  } else if (/gaste|gastam|consumo|gasto|entrou|receb|entrada/.test(q))
    text = `No histórico confirmado do mês: entradas de ${m(c.income_cents)} e consumo de ${m(c.expense_cents)}. Essas cifras não são o saldo bancário nem o total marcado como pago na lista.`;
  else if (/sobra|sobr|guardar|cabe|disponivel|plano|planejamento/.test(q))
    text = `O plano tem ${m(income)} de entradas e ${m(planned)} de compromissos: diferença de ${m(income - planned)}. Isso é uma comparação do planejamento, antes de imprevistos, e não comprova dinheiro disponível na conta.${items.some((i) => i.planned_cents === null) ? " Existem valores a definir; o total ainda é parcial." : ""}`;
  else if (/conta|pagar|vence|venc|falta|penden/.test(q)) {
    const upcoming = /semana|proxim|amanha/.test(q);
    const limit = new Date(c.today + "T12:00:00Z");
    limit.setUTCDate(limit.getUTCDate() + (/amanha/.test(q) ? 1 : 7));
    const end = limit.toISOString().slice(0, 10);
    const overdue = !upcoming && /venc|atras/.test(q);
    const list = open
      .filter((i) =>
        upcoming
          ? i.due_date && i.due_date >= c.today && i.due_date <= end
          : !overdue || (i.due_date && i.due_date <= c.today),
      )
      .sort((a, b) =>
        (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999"),
      );
    text = list.length
      ? `${list.length} compromissos ${upcoming ? `com vencimento entre ${brDate(c.today)} e ${brDate(end)}` : overdue ? "com vencimento até hoje" : "em aberto"}; ${m(list.reduce((s, i) => s + remainder(i), 0n))} com valor conhecido.\n` +
        list
          .slice(0, 8)
          .map(
            (i) =>
              `${i.label}: ${i.planned_cents === null ? "valor a definir" : m(remainder(i))} · ${i.due_date ? brDate(i.due_date) : "sem vencimento"}`,
          )
          .join("\n") +
        (list.length > 8 ? "\nA lista completa está em Mês." : "")
      : upcoming
        ? "Não há compromissos em aberto com data conhecida nesse período. Contas sem vencimento definido não entram nessa consulta."
        : overdue
          ? "Não há compromissos em aberto com vencimento conhecido até hoje. Contas sem data não são presumidas atrasadas."
          : "Não há compromissos em aberto nesta moeda e mês. Confira se todo o planejamento já foi incluído.";
  } else
    text =
      "Posso ajudar com contas a pagar, alimentação, entradas, consumo, sobra do planejamento, câmbio e investimentos. Para uma conversa livre, a integração externa ainda precisa ser configurada. Nenhum lançamento é criado por esta conversa.";
  return {
    text,
    source: `Planejamento e movimentos confirmados · ${c.month} · ${c.currency}`,
    coverage: `${c.bankReviewCount ?? 0} movimentos bancários do mês aguardam conferência. ${c.unresolved} movimentos do mês têm finalidade a esclarecer e ficam fora dos totais confirmados. Os dados não comprovam cobertura completa.`,
    mode: "local" as const,
  };
}
