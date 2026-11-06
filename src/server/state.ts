import type { Database } from "./db.ts";
import { asUser } from "./db.ts";
import type { Identity } from "./auth.ts";
import { analyzePending, pendingRows } from "./pending.ts";
import {
  economicEffect,
  savings,
  type Kind,
  type Currency,
} from "../domain/finance.ts";
export type EventRow = {
  id: string;
  kind: Kind;
  transaction_date: string;
  description: string;
  amount_cents: string;
  currency: Currency;
  account_id: string;
  counter_account_id: string | null;
  counter_currency: Currency | null;
  counter_amount_cents: string | null;
  category_id: string | null;
  category_name: string | null;
  account_name: string;
  created_by: string;
  sources: unknown[];
};
type AccountView = {
  observed_balance_cents?: string | null;
  observed_date?: string | null;
  observed_source?: string;
  id: string;
  name: string;
  institution: string;
  currency: Currency;
  kind: string;
  opening_cents: string | null;
  opening_date: string | null;
  balance_cents: string | null;
};
type BatchView = {
  context: { reconciliation?: { status: string; date: string } };
  id: string;
  account_id: string;
  status: string;
  parser: string;
  created_at: Date;
  filename: string;
  row_count: number;
  pending_count: number;
};
export async function readState(
  db: Database,
  user: Identity,
  month: string,
  currency: Currency,
  accountId?: string,
  categoryId?: string,
  withEvidence = true,
) {
  return asUser(db, user.userId, async (tx) => {
    const accounts = (
      await tx.query<AccountView>(
        "SELECT a.id,a.name,a.institution,a.currency,a.kind,a.opening_cents::text,a.opening_date::text,CASE WHEN a.opening_cents IS NULL THEN NULL ELSE (a.opening_cents+coalesce(sum(l.amount_cents),0))::text END AS balance_cents FROM accounts a LEFT JOIN ledger_entries l ON l.account_id=a.id WHERE a.household_id=$1 GROUP BY a.id ORDER BY a.name",
        [user.familyId],
      )
    ).rows;
    for (const account of accounts) {
      const observed = (
        await tx.query<{ cents: string; date: string; filename: string }>(
          "SELECT b.context->'closing'->>'cents' AS cents,b.context->'closing'->>'date' AS date,f.filename FROM import_batches b JOIN source_files f ON f.id=b.source_id WHERE b.household_id=$1 AND b.account_id=$2 AND b.context->'closing'->>'cents' IS NOT NULL AND jsonb_array_length(b.checks)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.checks) c WHERE (c->>'passed')::boolean=false) ORDER BY b.context->'closing'->>'date' DESC LIMIT 1",
          [user.familyId, account.id],
        )
      ).rows[0];
      if (observed) {
        account.observed_balance_cents = observed.cents;
        account.observed_date = observed.date;
        account.observed_source = observed.filename;
      }
    }
    const importTotals = (
      await tx.query<{
        rows: number;
        recorded: number;
        pending: number;
        files: number;
      }>(
        "SELECT (SELECT count(*)::integer FROM staged_transactions WHERE household_id=$1) AS rows,(SELECT count(*)::integer FROM event_sources WHERE household_id=$1) AS recorded,(SELECT count(*)::integer FROM staged_transactions s WHERE household_id=$1 AND NOT EXISTS(SELECT 1 FROM event_sources es WHERE es.staged_id=s.id)) AS pending,(SELECT count(*)::integer FROM source_files WHERE household_id=$1) AS files",
        [user.familyId],
      )
    ).rows[0];
    const bankRows = (
      await tx.query<{
        id: string;
        batch_id: string;
        ordinal: number;
        transaction_date: string;
        description: string;
        amount_cents: string;
        currency: Currency;
        filename: string;
        account_name: string;
        category_name: string | null;
        recorded: boolean;
        duplicate_hint: boolean;
        event_id: string | null;
        event_kind: string | null;
      }>(
        "SELECT s.id,s.batch_id,s.ordinal,s.transaction_date::text,s.description,s.amount_cents::text,s.currency,f.filename,a.name AS account_name,c.name AS category_name,EXISTS(SELECT 1 FROM event_sources es WHERE es.staged_id=s.id) AS recorded,s.duplicate_hint,(SELECT es.event_id FROM event_sources es WHERE es.staged_id=s.id LIMIT 1) AS event_id,(SELECT e.kind FROM event_sources es JOIN economic_events e ON e.id=es.event_id WHERE es.staged_id=s.id LIMIT 1) AS event_kind FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id JOIN source_files f ON f.id=b.source_id JOIN accounts a ON a.id=b.account_id LEFT JOIN categories c ON c.id=s.category_id WHERE s.household_id=$1 AND s.currency=$2 AND s.transaction_date>=$3::date AND s.transaction_date<($3::date+interval '1 month') AND ($4::uuid IS NULL OR b.account_id=$4) AND ($5::uuid IS NULL OR s.category_id=$5) ORDER BY s.transaction_date DESC,s.batch_id,s.ordinal",
        [user.familyId, currency, month, accountId ?? null, categoryId ?? null],
      )
    ).rows;
    const categories = (
      await tx.query<{ id: string; name: string; essential: boolean }>(
        "SELECT id,name,essential FROM categories WHERE household_id=$1 ORDER BY name",
        [user.familyId],
      )
    ).rows;
    const planning = (
      await tx.query<{
        sheet: string;
        cell: string;
        label: string;
        purpose: string;
        planned_cents: string | null;
        actual_cents: string | null;
        derived: boolean;
        error: string | null;
        actual_error: string | null;
        notes: string;
        filename: string;
        category_name: string;
      }>(
        "SELECT p.sheet,p.cell,p.label,p.purpose,p.planned_cents::text,p.actual_cents::text,p.derived,p.error,p.actual_error,p.notes,f.filename,c.name AS category_name FROM planning_lines p JOIN planning_sources f ON f.id=p.source_id JOIN categories c ON c.id=p.category_id WHERE p.household_id=$1 AND p.month=$2 AND $3='BRL' ORDER BY p.sheet,p.cell",
        [user.familyId, month, currency],
      )
    ).rows;
    const events = (
      await tx.query<EventRow>(
        "SELECT e.id,e.kind,e.transaction_date::text,e.description,e.amount_cents::text,e.currency,e.account_id,e.counter_account_id,e.counter_currency,e.counter_amount_cents::text,e.category_id,c.name AS category_name,a.name AS account_name,e.created_by,coalesce((SELECT json_agg(json_build_object('file',f.filename,'locator',s.locator,'original_description',s.original_description,'bank_id',s.bank_id)) FROM event_sources es JOIN staged_transactions s ON s.id=es.staged_id JOIN import_batches b ON b.id=s.batch_id JOIN source_files f ON f.id=b.source_id WHERE es.event_id=e.id),'[]')::jsonb || coalesce((SELECT jsonb_agg(jsonb_build_object('file','Meu Pluggy','locator',bt.remote_id,'source_kind','bank')) FROM bank_transactions bt WHERE bt.event_id=e.id AND bt.household_id=e.household_id),'[]'::jsonb) AS sources FROM economic_events e JOIN accounts a ON a.id=e.account_id LEFT JOIN categories c ON c.id=e.category_id WHERE e.household_id=$1 AND (e.currency=$2 OR e.counter_currency=$2) AND e.transaction_date>=$3::date AND e.transaction_date<($3::date+interval '1 month') AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM ledger_entries l WHERE l.event_id=e.id AND l.account_id=$4)) AND ($5::uuid IS NULL OR e.category_id=$5) ORDER BY e.transaction_date DESC,e.created_at DESC",
        [user.familyId, currency, month, accountId ?? null, categoryId ?? null],
      )
    ).rows.map((event) => {
      if (
        (accountId && event.counter_account_id === accountId) ||
        event.currency !== currency
      ) {
        return {
          ...event,
          amount_cents:
            event.counter_amount_cents ??
            (-BigInt(event.amount_cents)).toString(),
          currency,
          account_name:
            accounts.find((a) => a.id === event.counter_account_id)?.name ??
            event.account_name,
        };
      }
      return event;
    });
    let income = 0n,
      expense = 0n;
    const spending = new Map<string, bigint>();
    for (const event of events) {
      const effect = economicEffect(event.kind, BigInt(event.amount_cents));
      income += effect.income;
      expense += effect.expense;
      if (event.category_id)
        spending.set(
          event.category_id,
          (spending.get(event.category_id) ?? 0n) + effect.expense,
        );
    }
    const budgets = (
      await tx.query<{
        category_id: string;
        category_name: string;
        planned_cents: string;
      }>(
        "SELECT b.category_id,c.name AS category_name,b.planned_cents::text FROM budgets b JOIN categories c ON c.id=b.category_id WHERE b.household_id=$1 AND b.month=$2 AND b.currency=$3",
        [user.familyId, month, currency],
      )
    ).rows.map((b) => ({
      ...b,
      spent_cents: (spending.get(b.category_id) ?? 0n).toString(),
      remaining_cents: (
        BigInt(b.planned_cents) - (spending.get(b.category_id) ?? 0n)
      ).toString(),
    }));
    const batches = (
      await tx.query<BatchView>(
        "SELECT b.id,b.account_id,b.status,b.parser,b.created_at,b.context,f.filename,(SELECT count(*)::integer FROM staged_transactions s WHERE s.batch_id=b.id) AS row_count,(SELECT count(*)::integer FROM staged_transactions s WHERE s.batch_id=b.id AND (NOT s.reviewed OR s.decision='pending')) AS pending_count FROM import_batches b JOIN source_files f ON f.id=b.source_id WHERE b.household_id=$1 ORDER BY b.created_at DESC",
        [user.familyId],
      )
    ).rows;
    const duplicate = (
      await tx.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id WHERE s.household_id=$1 AND s.duplicate_hint AND b.status='preview'",
        [user.familyId],
      )
    ).rows[0].count;
    const audit = (
      await tx.query(
        "SELECT action,entity_id,metadata,created_at FROM audit_events WHERE household_id=$1 ORDER BY created_at DESC LIMIT 50",
        [user.familyId],
      )
    ).rows;
    const pendingAnalysis = analyzePending(
      withEvidence ? await pendingRows(tx, user.familyId) : [],
      user.name,
    );
    const insights: {
      type: string;
      title: string;
      fact: string;
      action: string;
      period: string;
    }[] = [];
    const pending = batches
      .filter((b) => b.status === "preview")
      .reduce((sum, b) => sum + Number(b.pending_count), 0);
    if (planning.some((p) => p.derived))
      insights.push({
        type: "budget",
        title: "Orçamento derivado da sua planilha",
        fact: "O planejamento deste mês usa os valores da coluna real como base, conforme sua instrução. As referências manuais não geram transações adicionais.",
        action:
          "Compare com os lançamentos bancários e ajuste o plano conforme seus compromissos atuais.",
        period: month.slice(0, 7),
      });
    if (planning.some((p) => p.error))
      insights.push({
        type: "budget",
        title: "Fórmulas de orçamento precisam de correção",
        fact: "Há itens com referência quebrada ou valor não numérico. A categoria afetada não recebe um total parcial apresentado como orçamento completo.",
        action:
          "Abra a origem na tela Orçamento e informe o planejamento correto da categoria.",
        period: month.slice(0, 7),
      });
    if (planning.some((p) => p.purpose === "benefit" || /caju/i.test(p.notes)))
      insights.push({
        type: "budget",
        title: "Gastos por benefício têm cobertura parcial",
        fact: "A planilha identifica pagamentos pelo Caju, mas não foi fornecido um extrato desse benefício. O realizado bancário pode ser menor que o consumo da família.",
        action:
          "Consulte a referência manual separada e forneça o extrato do benefício antes de concluir que houve economia.",
        period: month.slice(0, 7),
      });
    const largest = [...spending.entries()]
      .filter(([, v]) => v > 0n)
      .sort((a, b) => (a[1] > b[1] ? -1 : 1))[0];
    if (largest) {
      const cat = categories.find((c) => c.id === largest[0]);
      insights.push({
        type: "spending",
        title: `Maior despesa registrada: ${cat?.name ?? "categoria"}`,
        fact: "Esta categoria concentra o maior valor de despesas líquidas confirmadas no filtro atual. A cobertura ainda pode ser parcial.",
        action:
          "Confira as transações e compare com o orçamento antes de mudar os limites.",
        period: month.slice(0, 7),
      });
    }
    const usdIncome =
      (
        await tx.query(
          "SELECT 1 FROM economic_events WHERE household_id=$1 AND currency='USD' AND kind='income' AND transaction_date>=$2::date AND transaction_date<($2::date+interval '1 month') LIMIT 1",
          [user.familyId, month],
        )
      ).rows.length > 0;
    if (usdIncome)
      insights.push({
        type: "income_currency",
        title: "Recebimentos em dólar preservados",
        fact: "Os recebimentos profissionais em USD estão separados das conversões para BRL e EUR. Converter seu próprio saldo não cria nova receita.",
        action:
          "Selecione USD para consultar as receitas em dólar. Compare a viagem com os gastos em EUR, sem somar moedas diretamente.",
        period: month.slice(0, 7),
      });
    if (batches.some((b) => b.context?.reconciliation?.status === "difference"))
      insights.push({
        type: "reconciliation",
        title: "Diferença entre o banco e os registros locais",
        fact: "Existe um saldo observado no extrato que não coincide com a abertura e os movimentos registrados na conta.",
        action:
          "Abra a importação e confira a diferença. Revise abertura, lacunas e itens ignorados; nenhum ajuste foi criado automaticamente.",
        period: "Saldos de referência dos extratos confirmados",
      });
    if (pending)
      insights.push({
        type: "review",
        title: "Revisão antes dos indicadores",
        fact: `${pending} itens de importação aguardam decisão e ainda não afetam os resultados.`,
        action:
          "Abra as prévias, confira finalidade, categoria e possíveis transferências.",
        period: "Todas as prévias locais",
      });
    if (duplicate)
      insights.push({
        type: "duplicate",
        title: "Possíveis duplicidades",
        fact: `${duplicate} itens têm evidências semelhantes a outros registros. Isso não comprova duplicidade.`,
        action: "Compare as origens e justifique manter, vincular ou ignorar.",
        period: "Todas as prévias locais",
      });
    const missing = accounts.filter((a) => a.opening_cents === null).length;
    if (pendingAnalysis.counts.fx)
      insights.push({
        type: "pending_fx",
        title: "Câmbio e tarifas precisam de revisão conjunta",
        fact: `${pendingAnalysis.counts.fx} conversões identificadas nas prévias, com ${pendingAnalysis.counts.fees} tarifas Wise separadas. O principal convertido não é receita ou despesa; tarifas são custos separados.`,
        action:
          "Abra as pendências, confira principal líquido, tarifa e a segunda evidência antes de confirmar.",
        period: "Todas as prévias · não confirmado",
      });
    if (pendingAnalysis.counts.transfers)
      insights.push({
        type: "pending_transfer",
        title: "Transferências podem inflar renda e gastos",
        fact: `${pendingAnalysis.counts.transfers} pares de valores opostos citam seu nome em contas diferentes.`,
        action:
          "Confirme titularidade; trate cada par comprovado como uma operação única.",
        period: "Todas as prévias · não confirmado",
      });
    if (pendingAnalysis.counts.cards)
      insights.push({
        type: "pending_card",
        title: "Fatura não deve repetir as compras",
        fact: `${pendingAnalysis.counts.cards} pagamentos de fatura aguardam identificação do cartão e titular.`,
        action:
          "Escolha o cartão de contrapartida e confira se o consumo da fatura está coberto.",
        period: "Todas as prévias · não confirmado",
      });
    if (pendingAnalysis.counts.remittances)
      insights.push({
        type: "pending_remittance",
        title: "Remessa internacional ainda sem comprovante",
        fact: `${pendingAnalysis.counts.remittances} caso(s) de possível remessa ligam moedas diferentes sem ID compartilhado.`,
        action:
          "Confira o comprovante, o destino e os valores. Não presuma renda ou uma cotação.",
        period: "Todas as prévias · não confirmado",
      });
    // Coverage comes from declared statement intervals, never from filename dates.
    for (const account of accounts) {
      const periods = (
        await tx.query<{ start: string; end: string }>(
          "SELECT period_start::text AS start,period_end::text AS end FROM import_batches WHERE household_id=$1 AND account_id=$2 AND period_start IS NOT NULL AND period_end IS NOT NULL ORDER BY period_start",
          [user.familyId, account.id],
        )
      ).rows;
      const gaps: string[] = [];
      for (let i = 1; i < periods.length; i++) {
        const previousEnd = periods
          .slice(0, i)
          .map((p) => p.end)
          .sort()
          .at(-1)!;
        if (Date.parse(periods[i].start) - Date.parse(previousEnd) > 86400000)
          gaps.push(`${previousEnd} até ${periods[i].start}`);
      }
      if (gaps.length)
        insights.push({
          type: "pending_coverage",
          title: `Lacuna de extratos: ${account.name}`,
          fact: `Intervalos sem cobertura entre ${gaps.join("; ")}. As datas indicam os limites dos extratos adjacentes.`,
          action:
            "Forneça o período ausente antes de interpretar tendências ou concluir que não houve movimento.",
          period: "Cobertura dos arquivos locais",
        });
    }
    if (missing)
      insights.push({
        type: "opening",
        title: "Saldos ainda parciais",
        fact: `${missing} contas não têm abertura confirmada. A movimentação não representa o saldo total.`,
        action: "Informe o saldo de referência anterior ao primeiro movimento.",
        period: "Posição atual das contas",
      });
    for (const b of budgets.filter((b) => BigInt(b.remaining_cents) < 0n))
      insights.push({
        type: "budget",
        title: `Orçamento excedido: ${b.category_name}`,
        fact: "As despesas líquidas confirmadas superam o planejamento configurado para a categoria.",
        action:
          "Abra as transações da categoria e revise as prioridades do mês.",
        period: month.slice(0, 7),
      });
    const cards = events.filter((e) => e.kind === "card_payment");
    if (cards.length)
      insights.push({
        type: "card",
        title: "Faturas e consumo têm papéis diferentes",
        fact: `${cards.length} pagamentos de fatura estão classificados como liquidação de obrigação.`,
        action:
          "Confira se as compras de crédito e a obrigação inicial também foram registradas; sem isso, o consumo pode estar incompleto.",
        period: month.slice(0, 7),
      });
    const movements = events.filter((e) =>
      ["transfer", "investment_buy", "investment_sell", "fx"].includes(e.kind),
    );
    if (movements.some((e) => e.sources.length < 2))
      insights.push({
        type: "counterpart",
        title: "Contrapartidas a comprovar",
        fact: "Existem movimentações próprias cuja segunda perna foi criada pela revisão e ainda não tem outra origem vinculada.",
        action:
          "Ao importar o outro extrato, vincule a evidência ao evento existente em vez de criar outro movimento.",
        period: month.slice(0, 7),
      });
    return {
      user,
      month,
      currency,
      accounts,
      categories,
      events,
      budgets,
      batches,
      audit,
      insights,
      pending: pendingAnalysis,
      planning,
      bankRows,
      importTotals,
      summary: {
        income_cents: income.toString(),
        expense_cents: expense.toString(),
        result_cents: (income - expense).toString(),
        savings_basis_points: savings(income, expense),
        event_count: events.length,
      },
      coverage:
        "Resultados refletem somente eventos confirmados no filtro. Não comprovam cobertura completa das contas ou do mês.",
    };
  });
}
