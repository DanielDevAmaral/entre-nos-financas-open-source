import { normalize } from "./finance.ts";

export const reviewGroups = {
  history: "Coincidências com o histórico",
  statement: "Coincidências com os extratos",
  duplicate: "Possíveis duplicidades",
  transfer: "Transferências próprias",
  card: "Pagamentos de fatura",
  investment: "Aplicações e resgates",
  income: "Entradas identificadas",
  expense: "Despesas",
  unclear: "Precisam da sua decisão",
  pending: "Pendentes ou alterados no banco",
} as const;
export type ReviewGroup = keyof typeof reviewGroups;
export type Observation = {
  id: string;
  local_account_id: string;
  transaction_date: string;
  amount_cents: string;
  currency: string;
  description: string;
  provider_id?: string | null;
  provider_status: string;
  changed?: boolean;
  missing?: boolean;
  account_kind?: string;
  owner_id?: string;
  status?: string;
};
export type Evidence = {
  id: string;
  account_id: string;
  transaction_date: string;
  amount_cents: string;
  currency: string;
  description: string;
  filename?: string;
  event_id?: string | null;
  kind?: string;
};
export type Analysis = {
  semantic?: string;
  category_suggestion?: string;
  planning?: string[];
  group: ReviewGroup;
  reason: string;
  decision: string;
  event_ids: string[];
  staged_ids: string[];
  related_ids: string[];
  evidence: string[];
  version: 1;
};
const distance = (a: string, b: string) =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
const transfer = (s: string) => /PIX|TRANSFER|TED|DOC /.test(s);
const card = (s: string) =>
  /FATURA|PAGAMENTO RECEBIDO|PAGAMENTO DE CARTAO|PAGAMENTO CARTAO/.test(s);
const investment = (s: string) =>
  /RDB|APLICACAO|RESGATE|INVESTIMENTO|CDB/.test(s);
const similar = (a: string, b: string) => {
  const words = normalize(a)
    .split(/\W+/)
    .filter(
      (w) =>
        w.length > 4 &&
        ![
          "TRANSFERENCIA",
          "RECEBIDA",
          "ENVIADA",
          "PAGAMENTO",
          "COMPRA",
        ].includes(w),
    );
  return words.some((w) => normalize(b).split(/\W+/).includes(w));
};
export function analyzeObservations(
  rows: Observation[],
  legs: Evidence[],
  staged: Evidence[],
  incomeRules: {
    account_id: string;
    match_text: string;
    label: string;
    budget_offset: number;
  }[] = [],
): Map<string, Analysis> {
  const result = new Map<string, Analysis>();
  const peers = (r: Observation) =>
    rows.filter(
      (o) =>
        o.id !== r.id &&
        o.local_account_id !== r.local_account_id &&
        o.currency === r.currency &&
        BigInt(o.amount_cents) === -BigInt(r.amount_cents) &&
        distance(o.transaction_date, r.transaction_date) <= 3 &&
        !o.changed &&
        !o.missing &&
        o.provider_status === "POSTED",
    );
  const same = (r: Observation, e: Evidence) =>
    e.account_id === r.local_account_id &&
    e.currency === r.currency &&
    e.amount_cents === r.amount_cents;
  for (const r of rows) {
    const text = normalize(r.description),
      exact = legs.filter(
        (e) => same(r, e) && e.transaction_date === r.transaction_date,
      ),
      old = staged.filter(
        (e) =>
          !e.event_id &&
          same(r, e) &&
          e.transaction_date === r.transaction_date,
      );
    const near = legs.filter(
      (e) =>
        same(r, e) &&
        distance(e.transaction_date, r.transaction_date) <= 3 &&
        similar(r.description, e.description),
    );
    const repeats = rows.filter(
      (o) =>
        o.id !== r.id &&
        o.local_account_id === r.local_account_id &&
        o.amount_cents === r.amount_cents &&
        o.currency === r.currency &&
        ((r.provider_id && o.provider_id === r.provider_id) ||
          (o.transaction_date === r.transaction_date &&
            normalize(o.description) === text)),
    );
    const a: Analysis = {
      group: "unclear",
      reason: "A descrição não permite determinar a finalidade com segurança.",
      decision: "Informe se é despesa, entrada ou transferência e a categoria.",
      event_ids: exact.map((e) => e.id),
      staged_ids: old.map((e) => e.id),
      related_ids: [],
      evidence: old.map((e) => e.filename || "Extrato original"),
      version: 1,
    };
    if (exact.length) {
      a.group = "history";
      a.reason = `${exact.length} lançamento(s) com a mesma conta, data, moeda e valor.`;
      a.decision =
        "Confira a descrição e vincule ao histórico, se for o mesmo movimento. Não é uma duplicidade comprovada.";
    } else if (old.length) {
      a.group = "statement";
      a.reason =
        "O extrato original contém movimento da mesma conta, data e valor.";
      a.decision =
        "Confira o original antes de registrar; a prévia antiga ainda não é um lançamento.";
    } else if (near.length) {
      a.group = "duplicate";
      a.event_ids = near.map((e) => e.id);
      a.reason =
        "Valor e conta iguais ao histórico, descrição semelhante e data próxima.";
      a.decision =
        "Confira a diferença de data antes de vincular ou registrar outro movimento.";
    }
    if (repeats.length) {
      a.group = "duplicate";
      a.related_ids = repeats.map((o) => o.id);
      a.reason =
        "Há outros movimentos bancários com identificador ou dados iguais.";
      a.decision =
        "Confira se são duas operações legítimas. Nada foi descartado automaticamente.";
    }
    if (investment(text) && !exact.length && !old.length && !repeats.length) {
      a.group = "investment";
      a.reason = "A descrição indica aplicação ou resgate.";
      a.decision =
        "Identifique a conta de investimento e separe rendimentos do principal. Resgate não é salário.";
    }
    const pair = peers(r).filter(
      (o) =>
        !investment(normalize(o.description)) &&
        (card(text) ||
          card(normalize(o.description)) ||
          (transfer(text) &&
            transfer(normalize(o.description)) &&
            !!r.owner_id &&
            r.owner_id === o.owner_id)),
    );
    if (
      pair.length &&
      !exact.length &&
      !old.length &&
      !repeats.length &&
      !investment(text)
    ) {
      a.group =
        card(text) || pair.some((o) => card(normalize(o.description)))
          ? "card"
          : "transfer";
      a.related_ids = pair.map((o) => o.id);
      const mutual =
        pair.length === 1 &&
        peers(pair[0]).filter(
          (o) =>
            card(normalize(o.description)) ||
            card(normalize(pair[0].description)) ||
            (transfer(normalize(o.description)) &&
              transfer(normalize(pair[0].description)) &&
              o.owner_id === pair[0].owner_id),
        ).length === 1;
      a.reason = mutual
        ? "Encontrada uma contrapartida de sinal oposto em outra conta, com valor igual e data próxima."
        : "Existem várias contrapartidas possíveis; o valor sozinho não identifica a operação.";
      a.decision =
        a.group === "card"
          ? "Confirme a conta de origem e o cartão. Pagamento de fatura não é uma nova despesa."
          : "Confirme origem e destino. Transferência própria não é receita nem despesa.";
      a.evidence = pair.map((o) => `${o.transaction_date} · ${o.description}`);
    } else if (card(text) && !exact.length && !old.length && !repeats.length) {
      a.group = "card";
      a.reason =
        "A descrição indica pagamento de cartão, mas falta confirmar a contrapartida.";
      a.decision =
        "Escolha a conta/cartão correspondente; evite contar a fatura como uma nova despesa.";
    }
    if (a.group === "unclear") {
      if (/ESTORNO|REEMBOLSO|DEVOLUCAO/.test(text)) {
        a.reason = "Possível devolução ou estorno.";
        a.decision =
          "Identifique a despesa original antes de classificar como entrada.";
      } else if (
        BigInt(r.amount_cents) > 0n &&
        incomeRules.some(
          (rule) =>
            rule.account_id === r.local_account_id &&
            text.includes(normalize(rule.match_text)),
        )
      ) {
        a.group = "income";
        a.reason =
          "Entrada compatível com uma regra de recebimento desta família.";
        a.decision =
          "Confira valor, data e mês de destino da regra; não duplique a receita.";
      } else if (BigInt(r.amount_cents) < 0n && !transfer(text)) {
        a.group = "expense";
        a.reason =
          "Saída sem indício de transferência, fatura ou investimento.";
        a.decision = "Confira a categoria antes de registrar.";
      }
    }
    if (r.provider_status !== "POSTED" || r.changed || r.missing) {
      a.group = "pending";
      a.reason =
        "O banco ainda não confirmou o movimento ou alterou a evidência.";
      a.decision =
        "Aguarde ou revise a versão do banco antes de qualquer lançamento.";
    }
    a.semantic = investment(text)
      ? "Aplicação ou resgate"
      : card(text)
        ? "Pagamento de fatura"
        : exact.some((e) => e.kind === "transfer") || a.group === "transfer"
          ? "Transferência própria"
          : a.group === "income"
            ? "Recebimento previsto pela família"
            : /WISE|WIZE/.test(text) && BigInt(r.amount_cents) > 0n
              ? "Recebimento via Wise: conferir vínculo com o trabalho"
              : undefined;
    result.set(r.id, a);
  }
  return result;
}

export function incomeDate(payMonth: string, day = 25): string {
  const [year, month] = payMonth.split("-").map(Number);
  if (
    !/^\d{4}-\d{2}$/.test(payMonth) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 28
  )
    throw new Error("Regra de recebimento inválida.");
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() - 2);
  return date.toISOString().slice(0, 10);
}
export function followingMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
}

export function fifthBusinessDay(month: string): string {
  let date = month + "-01",
    count = 0;
  while (count < 5) {
    const d = new Date(date + "T00:00:00Z");
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) count++;
    if (count === 5) return date;
    d.setUTCDate(d.getUTCDate() + 1);
    date = d.toISOString().slice(0, 10);
  }
  return date;
}
