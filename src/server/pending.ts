import type { Transaction } from "@electric-sql/pglite";
import type { Database } from "./db.ts";
import { asUser, recordAudit } from "./db.ts";
import type { Identity } from "./auth.ts";
import { normalize, type Currency } from "../domain/finance.ts";

export type PendingRow = {
  category_id?: string | null;
  id: string;
  batch_id: string;
  account_id: string;
  account_name: string;
  filename: string;
  ordinal: number;
  locator: string;
  transaction_date: string;
  amount_cents: string;
  currency: Currency;
  bank_id: string | null;
  description: string;
  original_description: string;
  kind: string;
  counter_account_id: string | null;
  counter_currency: Currency | null;
  counter_amount_cents: string | null;
  decision: string;
  reviewed: boolean;
  version: number;
  review_note: string;
};
export type PendingFinding = {
  id: string;
  group: string;
  title: string;
  fact: string;
  action: string;
  strength: string;
  rows: PendingRow[];
};
export type FxCorrection = { row: PendingRow; other: PendingRow };
const abs = (v: bigint) => (v < 0n ? -v : v);
const day = (r: PendingRow) => r.transaction_date.slice(0, 10);
const days = (a: PendingRow, b: PendingRow) =>
  Math.abs(Date.parse(day(a)) - Date.parse(day(b))) / 86400000;
export const isWiseFee = (r: PendingRow) =>
  /^WISE CHARGES FOR:/i.test(r.original_description) &&
  r.bank_id?.startsWith("FEE-") &&
  BigInt(r.amount_cents) < 0n;
const fxId = (r: PendingRow) =>
  r.bank_id?.startsWith("BALANCE-") &&
  /convertidos para/i.test(r.original_description);

/** Only exact, reciprocal conversion IDs with an independently evidenced fee. */
export function fxEvidence(rows: PendingRow[]) {
  const groups = new Map<string, PendingRow[]>();
  for (const row of rows.filter(fxId)) {
    const key = row.bank_id!;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([id, legs]) => {
    const feeRows = rows.filter((r) => r.bank_id === "FEE-" + id);
    const fee = feeRows.length === 1 ? feeRows[0] : undefined;
    let safe = legs.length === 2 && !!fee && !!isWiseFee(fee);
    if (safe) {
      const [a, b] = legs;
      safe =
        a.account_id !== b.account_id &&
        a.currency !== b.currency &&
        day(a) === day(b) &&
        day(fee!) === day(a) &&
        BigInt(a.amount_cents) * BigInt(b.amount_cents) < 0n &&
        a.counter_currency === b.currency &&
        b.counter_currency === a.currency;
      for (const r of legs) {
        const other = legs.find((o) => o.id !== r.id)!;
        if (!r.counter_amount_cents) {
          safe = false;
          continue;
        }
        const difference =
          BigInt(r.counter_amount_cents) - BigInt(other.amount_cents);
        if (
          difference !== 0n &&
          !(
            fee!.account_id === other.account_id &&
            fee!.currency === other.currency &&
            difference === BigInt(fee!.amount_cents)
          )
        )
          safe = false;
      }
      // Fee belongs to the debit account, never the receiving account.
      const debit = legs.find((r) => BigInt(r.amount_cents) < 0n)!;
      if (
        fee!.account_id !== debit.account_id ||
        fee!.currency !== debit.currency
      )
        safe = false;
    }
    return { id, legs, fee, safe };
  });
}

export function analyzePending(rows: PendingRow[], name = "") {
  const findings: PendingFinding[] = [];
  const add = (
    group: string,
    title: string,
    fact: string,
    action: string,
    strength: string,
    evidence: PendingRow[],
  ) =>
    findings.push({
      id:
        group +
        ":" +
        evidence
          .map((r) => r.id)
          .sort()
          .join(":"),
      group,
      title,
      fact,
      action,
      strength,
      rows: evidence,
    });
  const conversions = fxEvidence(rows);
  for (const c of conversions) {
    const fixed =
      c.safe &&
      c.legs.every((r) => {
        const other = c.legs.find((o) => o.id !== r.id)!;
        return (
          r.counter_account_id === other.account_id &&
          r.counter_amount_cents === other.amount_cents &&
          r.kind === "fx"
        );
      }) &&
      c.fee?.kind === "fee";
    add(
      "Câmbio",
      fixed ? "Principal e tarifa separados" : "Conferir principal e tarifa",
      c.safe
        ? "Mesmo ID nas duas moedas e tarifa separada conciliada. O débito bancário original é preservado; a contrapartida deve usar o principal líquido da outra linha."
        : "Evidência incompleta, ambígua ou divergente. Nenhum ajuste automático é permitido.",
      "Revise as duas contas e a tarifa. Registre uma única conversão e vincule a segunda evidência ao mesmo evento. Não conte a tarifa citada no texto duas vezes.",
      fixed
        ? "Ajustado · decisão pendente"
        : c.safe
          ? "Ajuste seguro disponível"
          : "Comprovante necessário",
      [...c.legs, ...(c.fee ? [c.fee] : [])],
    );
  }
  const fees = rows.filter(isWiseFee);
  const exact = new Map<string, PendingRow[]>(),
    ids = new Map<string, PendingRow[]>();
  for (const r of rows) {
    const k = [
      r.account_id,
      day(r),
      r.currency,
      r.amount_cents,
      normalize(r.original_description),
    ].join("|");
    exact.set(k, [...(exact.get(k) ?? []), r]);
    if (r.bank_id) {
      const id = r.account_id + "|" + r.bank_id;
      ids.set(id, [...(ids.get(id) ?? []), r]);
    }
  }
  for (const rs of exact.values())
    if (rs.length > 1) {
      const distinct =
        new Set(rs.map((r) => r.bank_id).filter(Boolean)).size > 1;
      add(
        "Duplicidades",
        "Campos repetidos na mesma conta",
        distinct
          ? "Data, valor e descrição coincidem, mas os IDs são distintos. Podem ser operações legítimas."
          : "Data, valor e descrição coincidem. Isso não comprova que uma linha deva ser removida.",
        "Confira os comprovantes. Manter ambas ou ignorar uma evidência exige decisão e justificativa.",
        distinct
          ? "IDs distintos · não excluir automaticamente"
          : "Sua decisão",
        rs,
      );
    }
  for (const rs of ids.values())
    if (
      rs.length > 1 &&
      new Set(
        rs.map(
          (r) => day(r) + "|" + r.amount_cents + "|" + r.original_description,
        ),
      ).size > 1
    )
      add(
        "Duplicidades",
        "Identificador reutilizado",
        "Mesmo ID com valores ou descrições diferentes; pode ser ajuste, débito fracionado ou estorno.",
        "Preserve os registros até conferir o extrato. Para estorno, vincule à despesa original apropriada.",
        "Sua decisão",
        rs,
      );
  const paired = new Set<string>();
  const conversionRows = new Set(
    conversions.flatMap((c) => c.legs.map((r) => r.id)),
  );
  const ownerTokens = normalize(name)
    .split(" ")
    .filter((t) => t.length > 2 && !["DOS", "DAS"].includes(t));
  const own = (r: PendingRow) =>
    ownerTokens.length >= 2 &&
    ownerTokens.every((t) =>
      normalize(r.description)
        .split(/[^A-Z0-9]+/)
        .includes(t),
    );
  const transfer = (r: PendingRow) =>
    /TRANSF|ENVIOU DINHEIRO|RECEBEU DINHEIRO/.test(normalize(r.description));
  const identifiesProvider = (row: PendingRow, other: PendingRow) => {
    const account = normalize(other.account_name),
      description = normalize(row.description);
    if (account.includes("WISE")) return /\bWISE\b/.test(description);
    if (account.includes("NUBANK"))
      return /\b(NUBANK|NU PAGAMENTOS)\b/.test(description);
    if (account.includes("ITAU")) return /\bITAU\b/.test(description);
    return false;
  };
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    if (conversionRows.has(a.id) || isWiseFee(a)) continue;
    for (const b of rows.slice(i + 1)) {
      if (
        a.account_id === b.account_id ||
        a.currency !== b.currency ||
        BigInt(a.amount_cents) !== -BigInt(b.amount_cents) ||
        days(a, b) > 3 ||
        conversionRows.has(b.id) ||
        isWiseFee(b)
      )
        continue;
      // Do not present unrelated merchant payments or RDB redemptions as transfers.
      if (
        !transfer(a) ||
        !transfer(b) ||
        !(
          (own(a) && own(b)) ||
          (own(a) && identifiesProvider(b, a)) ||
          (own(b) && identifiesProvider(a, b))
        )
      )
        continue;
      paired.add(a.id);
      paired.add(b.id);
      add(
        "Transferências",
        "Provável transferência entre suas contas",
        `Valores opostos na mesma moeda; diferença de ${days(a, b)} dia(s). Há identificação do titular e da conta ou instituição da contrapartida.`,
        "Confirme titularidade e finalidade. Se for a mesma operação, registre uma transferência e vincule a outra evidência, sem criar renda ou consumo.",
        "Correspondência provável",
        [a, b],
      );
    }
  }
  for (const r of rows) {
    const t = normalize(r.description);
    if (r.kind === "card_payment" || /PAGAMENTO DE FATURA/.test(t)) {
      add(
        "Faturas",
        "Identificar cartão e titular",
        "O extrato registra pagamento de fatura, não detalha as compras pagas.",
        "Escolha o cartão próprio ou esclareça se é pagamento para terceiro. Não some o pagamento às compras como nova despesa.",
        "Sua decisão",
        [r],
      );
    } else if (
      !conversionRows.has(r.id) &&
      !isWiseFee(r) &&
      !paired.has(r.id) &&
      transfer(r)
    ) {
      if (own(r) && r.currency !== "BRL" && BigInt(r.amount_cents) < 0n) {
        const credits = rows.filter(
          (b) =>
            b.currency !== r.currency &&
            BigInt(b.amount_cents) > 0n &&
            days(r, b) <= 3 &&
            /WISE/.test(normalize(b.description)) &&
            transfer(b),
        );
        if (credits.length)
          add(
            "Remessas a comprovar",
            "Possível remessa com conversão",
            "Saída em moeda estrangeira para seu nome e crédito identificado como Wise próximo da data. Sem ID compartilhado nem conversão explícita.",
            "Confira o comprovante para identificar valor recebido, principal e tarifa. Não invente cotação nem presuma renda.",
            "Comprovante necessário",
            [
              r,
              ...credits,
              ...fees.filter((f) => f.bank_id === "FEE-" + r.bank_id),
            ],
          );
      }
      add(
        "Titularidade",
        /LTDA|DEV|EMPRESA/.test(t)
          ? "Definir relação entre pessoa física e empresa"
          : "Transferência sem contrapartida comprovada",
        "Não há par suficientemente comprovado nas contas importadas. Nome e Pix não definem renda, consumo ou titularidade.",
        "Informe a conta e a finalidade. Para PJ, diferencie pró-labore, distribuição, reembolso e aporte; para familiares, confirme se a conta pertence ao espaço familiar.",
        "Sua decisão",
        [r],
      );
    } else if (["investment_buy", "investment_sell", "refund"].includes(r.kind))
      add(
        "Investimentos e estornos",
        r.kind === "refund"
          ? "Vincular estorno à despesa"
          : "Identificar conta de investimento",
        "Principal de aplicação/resgate não é consumo nem rendimento. Estorno exige a despesa original.",
        "Defina a contrapartida de investimento ou vincule a despesa original. Preserve rendimentos separados.",
        "Sua decisão",
        [r],
      );
  }
  const totals = (["BRL", "USD", "EUR"] as Currency[])
    .map((currency) => ({
      currency,
      cents: fees
        .filter((r) => r.currency === currency)
        .reduce((n, r) => n + abs(BigInt(r.amount_cents)), 0n)
        .toString(),
      count: fees.filter((r) => r.currency === currency).length,
    }))
    .filter((t) => t.count);
  for (const total of totals)
    add(
      "Tarifas",
      `${total.count} tarifas Wise em ${total.currency}`,
      "Débitos separados do principal, identificados por FEE e referência à operação.",
      "Revise a categoria de tarifas e o vínculo com a operação. A moeda original é preservada.",
      "Principal separado",
      fees.filter((r) => r.currency === total.currency),
    );
  return {
    findings,
    totals,
    counts: {
      rows: rows.length,
      fx: conversions.length,
      fxSafe: conversions.filter((c) => c.safe).length,
      transfers: findings.filter((f) => f.group === "Transferências").length,
      duplicates: findings.filter((f) => f.group === "Duplicidades").length,
      cards: findings.filter((f) => f.group === "Faturas").length,
      remittances: findings.filter((f) => f.group === "Remessas a comprovar")
        .length,
      fees: fees.length,
    },
  };
}

export async function pendingRows(
  tx: Transaction,
  family: string,
  lock = false,
) {
  return (
    await tx.query<PendingRow>(
      `SELECT s.*,s.transaction_date::text,s.amount_cents::text,s.counter_amount_cents::text,b.account_id,a.name AS account_name,f.filename FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id JOIN accounts a ON a.id=b.account_id JOIN source_files f ON f.id=b.source_id WHERE s.household_id=$1 AND b.status='preview' AND NOT EXISTS(SELECT 1 FROM event_sources es WHERE es.staged_id=s.id) ORDER BY s.transaction_date,s.batch_id,s.ordinal ${lock ? "FOR UPDATE OF s,b" : ""}`,
      [family],
    )
  ).rows;
}

export async function repairPendingFx(db: Database, user: Identity) {
  return asUser(db, user.userId, async (tx) => {
    const rows = await pendingRows(tx, user.familyId, true);
    const corrections: FxCorrection[] = [];
    for (const c of fxEvidence(rows).filter((c) => c.safe))
      for (const row of c.legs) {
        const other = c.legs.find((r) => r.id !== row.id)!;
        // Never overwrite saved human decisions, custom notes, links or account choices.
        if (
          row.reviewed ||
          row.decision !== "pending" ||
          row.review_note.trim() ||
          row.kind !== "fx" ||
          (row.counter_account_id &&
            row.counter_account_id !== other.account_id)
        )
          continue;
        if (
          row.counter_amount_cents !== other.amount_cents ||
          row.counter_account_id !== other.account_id
        )
          corrections.push({ row, other });
      }
    let changed = 0;
    for (const { row, other } of corrections) {
      await tx.query(
        "UPDATE staged_transactions SET counter_currency=$1,counter_amount_cents=$2,counter_account_id=$3,version=version+1 WHERE id=$4 AND household_id=$5",
        [
          other.currency,
          other.amount_cents,
          other.account_id,
          row.id,
          user.familyId,
        ],
      );
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "import.fx.prepare",
        row.id,
        {
          before: {
            counter_amount_cents: row.counter_amount_cents,
            counter_account_id: row.counter_account_id,
          },
          after: {
            counter_amount_cents: other.amount_cents,
            counter_account_id: other.account_id,
          },
          evidence_id: other.id,
          decision: "pending",
        },
      );
      changed++;
    }
    for (const row of rows.filter(isWiseFee)) {
      if (
        row.reviewed ||
        row.decision !== "pending" ||
        row.review_note.trim() ||
        row.kind !== "expense"
      )
        continue;
      await tx.query(
        "UPDATE staged_transactions SET kind='fee',suggested_kind='fee',category_id=coalesce(category_id,(SELECT id FROM categories WHERE household_id=$1 AND name='Impostos e tarifas' LIMIT 1)),version=version+1 WHERE id=$2 AND household_id=$1",
        [user.familyId, row.id],
      );
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "import.fee.prepare",
        row.id,
        { before: row.kind, after: "fee", decision: "pending" },
      );
      changed++;
    }
    return { changed, decisionsSaved: 0, confirmed: 0 };
  });
}
