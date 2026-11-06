import { randomUUID } from "node:crypto";
import type { Transaction } from "@electric-sql/pglite";
import { z } from "zod";
import {
  analyzeObservations,
  incomeDate,
  fifthBusinessDay,
  followingMonth,
  type Observation,
  type Evidence,
} from "../domain/bank-analysis.ts";
import { categoryFor } from "./assisted.ts";
import { normalize } from "../domain/finance.ts";
import { asUser, recordAudit, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { UserError } from "./imports.ts";
export async function analyzeBanksTx(tx: Transaction, u: Identity) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "bank-analysis:" + u.familyId,
  ]);
  const bank = (
    await tx.query<Observation>(
      `SELECT b.*,transaction_date::text,amount_cents::text,a.kind AS account_kind,c.user_id AS owner_id FROM bank_transactions b JOIN accounts a ON a.id=b.local_account_id JOIN bank_accounts ba ON ba.id=b.bank_account_id JOIN bank_connections c ON c.id=ba.connection_id WHERE b.household_id=$1`,
      [u.familyId],
    )
  ).rows;
  const legs = (
    await tx.query<Evidence>(
      `SELECT e.id,e.description,e.transaction_date::text,l.account_id,l.currency,l.amount_cents::text,e.kind FROM economic_events e JOIN ledger_entries l ON l.event_id=e.id WHERE e.household_id=$1`,
      [u.familyId],
    )
  ).rows;
  const staged = (
    await tx.query<Evidence>(
      `SELECT s.id,s.description,s.transaction_date::text,s.amount_cents::text,s.currency,b.account_id,f.filename,es.event_id FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id JOIN source_files f ON f.id=b.source_id LEFT JOIN event_sources es ON es.staged_id=s.id WHERE s.household_id=$1`,
      [u.familyId],
    )
  ).rows;
  const incomeRules = (
    await tx.query<{
      account_id: string;
      match_text: string;
      label: string;
      budget_offset: number;
    }>(
      "SELECT account_id,match_text,label,budget_offset FROM income_rules WHERE household_id=$1 AND enabled",
      [u.familyId],
    )
  ).rows;
  const analysis = analyzeObservations(bank, legs, staged, incomeRules);
  const planning = (
    await tx.query<{
      label: string;
      month: string;
      sheet: string;
      cell: string;
      planned_cents: string | null;
      actual_cents: string | null;
      filename: string;
    }>(
      `SELECT p.label,p.month::text,p.sheet,p.cell,p.planned_cents::text,p.actual_cents::text,s.filename FROM planning_lines p JOIN planning_sources s ON s.id=p.source_id WHERE p.household_id=$1`,
      [u.familyId],
    )
  ).rows;
  const merchants = (
    await tx.query<{ match_text: string; category_name: string; note: string }>(
      "SELECT match_text,category_name,note FROM merchant_rules WHERE household_id=$1",
      [u.familyId],
    )
  ).rows;
  for (const row of bank) {
    const a = analysis.get(row.id)!;
    const text = normalize(row.description);
    const category = categoryFor(row.description);
    const known = merchants.find((m) => text.includes(normalize(m.match_text)));
    if (
      !["transfer", "card", "investment", "income"].includes(a.group) &&
      BigInt(row.amount_cents) < 0n
    ) {
      if (known)
        a.category_suggestion = known.category_name + " · " + known.note;
      else if (category.strong) a.category_suggestion = category.name;
    }
    const matchedIncome = incomeRules.find(
      (rule) =>
        rule.account_id === row.local_account_id &&
        text.includes(normalize(rule.match_text)),
    );
    const target =
      matchedIncome?.budget_offset === 1
        ? followingMonth(row.transaction_date.slice(0, 7))
        : row.transaction_date.slice(0, 7);
    const matches = planning.filter(
      (p) =>
        p.month.startsWith(target) &&
        normalize(p.label)
          .split(/\W+/)
          .some((w) => w.length >= 5 && text.includes(w)),
    );
    a.planning = matches
      .slice(0, 4)
      .map(
        (p) =>
          `${p.filename} · ${p.sheet}!${p.cell} · ${p.label}. Referência planejada, não comprova pagamento.`,
      );
  }
  await tx.query(
    `UPDATE bank_transactions b SET analysis=x.analysis,analyzed_at=now() FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,analysis jsonb) WHERE b.id=x.id AND b.household_id=$2 AND b.analysis IS DISTINCT FROM x.analysis`,
    [
      JSON.stringify([...analysis].map(([id, a]) => ({ id, analysis: a }))),
      u.familyId,
    ],
  );
  await refreshIncomeTx(tx, u, bank);
  const counts: Record<string, number> = {};
  for (const r of bank.filter((b) => b.status === "pending")) {
    const group = analysis.get(r.id)!.group;
    counts[group] = (counts[group] || 0) + 1;
  }
  return {
    counts,
    total: bank.filter((b) => b.status === "pending").length,
    financial_events_created: 0,
  };
}
export async function analyzeBanks(db: Database, u: Identity) {
  if (!["owner", "editor"].includes(u.role))
    throw new UserError("Seu acesso é somente para leitura.");
  return asUser(db, u.userId, async (tx) => {
    const result = await analyzeBanksTx(tx, u);
    await recordAudit(
      tx,
      u.familyId,
      u.userId,
      "bank.analysis",
      u.familyId,
      result,
    );
    return result;
  });
}
type Rule = {
  id: string;
  account_id: string;
  label: string;
  match_text: string;
  day: number;
  expected_cents: string;
  effective_month: string;
  enabled: boolean;
  receipt_mode: "fixed" | "business_window";
  budget_offset: number;
};
export async function configureIncome(db: Database, u: Identity, raw: unknown) {
  if (!["owner", "editor"].includes(u.role))
    throw new UserError("Seu acesso é somente para leitura.");
  const v = z
    .object({
      account_id: z.uuid(),
      label: z.string().trim().min(1).max(180),
      match_text: z.string().trim().min(3).max(120),
      day: z.number().int().min(1).max(28),
      expected_cents: z.string().regex(/^[1-9]\d{0,12}$/),
      effective_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      enabled: z.boolean().default(true),
      receipt_mode: z.enum(["fixed", "business_window"]).default("fixed"),
      budget_offset: z.number().int().min(0).max(1).default(1),
    })
    .strict()
    .parse(raw);
  return asUser(db, u.userId, async (tx) => {
    // Serialize family planning writes, including repeated requests from two phones.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "bank-analysis:" + u.familyId,
    ]);
    const account = (
      await tx.query(
        `SELECT id FROM accounts WHERE household_id=$1 AND id=$2 AND kind='checking' AND currency='BRL'`,
        [u.familyId, v.account_id],
      )
    ).rows[0];
    if (!account)
      throw new UserError("Escolha uma conta corrente em reais da família.");
    const previous = (
      await tx.query<Rule>(
        `SELECT *,effective_month::text FROM income_rules WHERE household_id=$1 AND account_id=$2 AND match_text=$3`,
        [u.familyId, v.account_id, normalize(v.match_text)],
      )
    ).rows[0];
    if (
      previous &&
      (previous.label !== v.label ||
        previous.budget_offset !== v.budget_offset ||
        previous.receipt_mode !== v.receipt_mode ||
        previous.effective_month !== v.effective_month + "-01")
    )
      throw new UserError(
        "A regra já tem uma destinação de orçamento. Preserve-a e revise o planejamento antes de alterar essa destinação.",
      );
    await tx.query(
      `INSERT INTO income_rules(id,household_id,account_id,label,match_text,day,expected_cents,effective_month,enabled,created_by,receipt_mode,budget_offset) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(household_id,account_id,match_text) DO UPDATE SET label=excluded.label,day=excluded.day,expected_cents=excluded.expected_cents,effective_month=excluded.effective_month,enabled=excluded.enabled,receipt_mode=excluded.receipt_mode,budget_offset=excluded.budget_offset`,
      [
        randomUUID(),
        u.familyId,
        v.account_id,
        v.label,
        normalize(v.match_text),
        v.day,
        v.expected_cents,
        v.effective_month + "-01",
        v.enabled,
        u.userId,
        v.receipt_mode,
        v.budget_offset,
      ],
    );
    const result = await analyzeBanksTx(tx, u);
    await recordAudit(tx, u.familyId, u.userId, "income.rule", u.familyId, {
      day: v.day,
      budget_month_offset: v.budget_offset,
      weekend: "previous_friday",
      financial_events_created: 0,
    });
    return result;
  });
}
async function refreshIncomeTx(
  tx: Transaction,
  u: Identity,
  bank: Observation[],
) {
  const rules = (
    await tx.query<Rule>(
      `SELECT *,expected_cents::text,effective_month::text FROM income_rules WHERE household_id=$1 AND enabled ORDER BY id FOR UPDATE`,
      [u.familyId],
    )
  ).rows;
  for (const rule of rules) {
    // Forecast upcoming receipt months, never backdate or invent a bank event.
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Sao_Paulo",
    }).format(new Date());
    let month = rule.effective_month.slice(0, 7);
    const end = followingMonth(followingMonth(today.slice(0, 7)));
    for (
      let n = 0;
      n < 120 && month <= end;
      n++, month = followingMonth(month)
    ) {
      const budget = rule.budget_offset === 1 ? followingMonth(month) : month,
        expected =
          rule.receipt_mode === "business_window"
            ? fifthBusinessDay(month)
            : incomeDate(month, rule.day);
      const plans = (
        await tx.query<{ id: string }>(
          `SELECT id FROM monthly_items WHERE household_id=$1 AND month=$2 AND purpose='income' AND NOT archived AND upper(label)=upper($3) ORDER BY id FOR UPDATE`,
          [u.familyId, budget + "-01", rule.label],
        )
      ).rows;
      // Ambiguous planning rows are left untouched; do not create another one.
      if (plans.length > 1) continue;
      let itemId = plans[0]?.id;
      if (!itemId) {
        itemId = randomUUID();
        await tx.query(
          `INSERT INTO monthly_items(id,household_id,month,label,purpose,currency,planned_cents,notes,source_note,created_by) VALUES($1,$2,$3,$4,'income','BRL',$5,$6,$7,$8)`,
          [
            itemId,
            u.familyId,
            budget + "-01",
            rule.label,
            rule.expected_cents,
            rule.budget_offset === 1
              ? "Previsão: recebimento no mês anterior. Não representa receita confirmada."
              : "Previsão variável no mesmo mês. Não representa receita confirmada.",
            rule.receipt_mode === "business_window"
              ? "Janela esperada: cinco primeiros dias úteis, sem data ou valor garantidos; feriados podem alterar a estimativa. Financia o mesmo mês."
              : "Regra familiar: dia " +
                rule.day +
                ", antecipado para sexta no fim de semana; financia o mês seguinte.",
            u.userId,
          ],
        );
      }
      const found = bank.filter(
        (b) =>
          b.local_account_id === rule.account_id &&
          b.transaction_date.startsWith(month) &&
          BigInt(b.amount_cents) > 0n &&
          (normalize(b.description).includes(normalize(rule.match_text)) ||
            (rule.receipt_mode === "business_window" &&
              /WISE|WIZE/.test(normalize(b.description)))),
      );
      const one = found.length === 1 ? found[0] : undefined;
      const valid =
        one &&
        one.provider_status === "POSTED" &&
        !one.changed &&
        !one.missing &&
        rule.receipt_mode === "fixed" &&
        one.transaction_date === expected &&
        one.amount_cents === rule.expected_cents;
      const state =
        found.length === 0 ? "planned" : valid ? "detected" : "review";
      const note =
        found.length > 1
          ? "Mais de um crédito compatível: escolha o recebimento correto."
          : one && !valid
            ? rule.receipt_mode === "business_window"
              ? "Crédito via Wise candidato ao salário. Confira a origem do trabalho e o valor convertido; nem todo Pix Wise é salário."
              : "Data, valor ou situação divergem da regra: confira no banco."
            : valid
              ? "Crédito identificado no banco; aguarda sua revisão. Nenhum lançamento confirmado."
              : rule.receipt_mode === "business_window"
                ? "Janela aproximada de cinco dias de semana; feriados podem alterar a estimativa. Data e valor precisam de revisão."
                : "Previsão de recebimento; ainda não identificado no banco.";
      await tx.query(
        `INSERT INTO income_occurrences(id,household_id,rule_id,pay_month,expected_date,budget_month,monthly_item_id,bank_transaction_id,state,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(rule_id,pay_month) DO UPDATE SET expected_date=excluded.expected_date,bank_transaction_id=excluded.bank_transaction_id,state=excluded.state,note=excluded.note`,
        [
          randomUUID(),
          u.familyId,
          rule.id,
          month + "-01",
          expected,
          budget + "-01",
          itemId,
          one?.id || null,
          state,
          note,
        ],
      );
    }
  }
}
export async function readIncomeRules(tx: Transaction, family: string) {
  return (
    await tx.query<Rule & { account_name: string }>(
      `SELECT r.id,r.account_id,r.label,r.match_text,r.day,r.expected_cents::text,r.effective_month::text,r.enabled,r.receipt_mode,r.budget_offset,a.name AS account_name FROM income_rules r JOIN accounts a ON a.id=r.account_id WHERE r.household_id=$1 ORDER BY r.label`,
      [family],
    )
  ).rows;
}
