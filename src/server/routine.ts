import type { Transaction } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { asUser, recordAudit, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { cents, dateOnly } from "../domain/finance.ts";
import { UserError } from "./imports.ts";
export type MonthlyItem = {
  id: string;
  month: string;
  label: string;
  purpose: string;
  cost_type?: "fixed" | "variable" | null;
  currency: string;
  planned_cents: string | null;
  paid_cents: string | null;
  actual_reference_cents: string | null;
  status: string;
  due_date: string | null;
  paid_date: string | null;
  notes: string;
  source_note: string;
  source_line_id: string | null;
  category_id: string | null;
  event_id: string | null;
  derived: boolean;
  version: number;
  funding?: {
    expected_date: string;
    receipt_mode?: string;
    received_date: string | null;
    state: string;
    note: string;
    bank_transaction_id: string | null;
  };
};
export const itemSchema = z
  .object({
    id: z.uuid().optional(),
    version: z.number().int().positive().optional(),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    label: z.string().trim().min(1).max(180),
    purpose: z.enum(["expense", "income", "saving", "card", "benefit"]),
    currency: z.enum(["BRL", "USD", "EUR"]),
    cost_type: z.enum(["fixed", "variable"]).nullable().optional(),
    amount: z.string().max(30),
    due_date: z.string().nullable(),
    category_id: z.uuid().nullable().default(null),
    notes: z.string().max(1000).default(""),
  })
  .strict();
export async function readRoutine(db: Database, user: Identity, month: string) {
  dateOnly(month + "-01");
  return asUser(db, user.userId, async (tx) => {
    const items = (
      await tx.query<MonthlyItem>(
        `SELECT id,month::text,label,purpose,cost_type,currency,planned_cents::text,paid_cents::text,actual_reference_cents::text,status,due_date::text,paid_date::text,notes,source_note,source_line_id,category_id,event_id,derived,version FROM monthly_items WHERE household_id=$1 AND month=$2 AND NOT archived ORDER BY status='done',due_date NULLS LAST,label`,
        [user.familyId, month + "-01"],
      )
    ).rows;
    const funding = (
      await tx.query<{
        monthly_item_id: string;
        receipt_mode: string;
        expected_date: string;
        received_date: string | null;
        state: string;
        note: string;
        bank_transaction_id: string | null;
      }>(
        `SELECT r.receipt_mode,o.monthly_item_id,o.expected_date::text,b.transaction_date::text AS received_date,o.state,o.note,o.bank_transaction_id FROM income_occurrences o JOIN income_rules r ON r.id=o.rule_id LEFT JOIN bank_transactions b ON b.id=o.bank_transaction_id WHERE o.household_id=$1 AND o.budget_month=$2 AND r.enabled`,
        [user.familyId, month + "-01"],
      )
    ).rows;
    const candidates = (
      await tx.query<{
        id: string;
        description: string;
        amount_cents: string;
        currency: string;
        kind: string;
        transaction_date: string;
      }>(
        `SELECT id,description,amount_cents::text,currency,kind,transaction_date::text FROM economic_events WHERE household_id=$1 AND ((transaction_date>=$2::date AND transaction_date<($2::date+interval '1 month')) OR id IN (SELECT b.event_id FROM income_occurrences o JOIN bank_transactions b ON b.id=o.bank_transaction_id WHERE o.household_id=$1 AND o.budget_month=$2))`,
        [user.familyId, month + "-01"],
      )
    ).rows;
    const receipts = (
      await tx.query<{
        label: string;
        expected_date: string;
        received_date: string | null;
        budget_month: string;
        state: string;
        note: string;
        amount_cents: string | null;
      }>(
        `SELECT r.label,o.expected_date::text,b.transaction_date::text AS received_date,o.budget_month::text,o.state,o.note,b.amount_cents::text FROM income_occurrences o JOIN income_rules r ON r.id=o.rule_id LEFT JOIN bank_transactions b ON b.id=o.bank_transaction_id WHERE o.household_id=$1 AND o.pay_month=$2 AND r.enabled AND o.budget_month<>o.pay_month`,
        [user.familyId, month + "-01"],
      )
    ).rows;
    return {
      receipts,
      items: items.map((item) => ({
        ...item,
        funding: funding.find((f) => f.monthly_item_id === item.id),
        candidates: candidates
          .filter(
            (e) =>
              e.currency === item.currency &&
              (item.purpose === "income"
                ? ["income", "yield"].includes(e.kind)
                : item.purpose === "card"
                  ? e.kind === "card_payment"
                  : ["expense", "fee", "card_purchase"].includes(e.kind)) &&
              item.planned_cents !== null &&
              (BigInt(e.amount_cents) < 0n
                ? -BigInt(e.amount_cents)
                : BigInt(e.amount_cents)) === BigInt(item.planned_cents),
          )
          .slice(0, 6),
      })),
    };
  });
}
export async function saveItem(db: Database, user: Identity, raw: unknown) {
  return asUser(db, user.userId, (tx) => saveItemTx(tx, user, raw));
}
export async function saveItemTx(
  tx: Transaction,
  user: Identity,
  raw: unknown,
) {
  const input = itemSchema.parse(raw),
    month = dateOnly(input.month + "-01");
  const amount = input.amount.trim() ? cents(input.amount).toString() : null;
  if (amount !== null && BigInt(amount) < 0n)
    throw new UserError("Informe um valor positivo.");
  const due = input.due_date ? dateOnly(input.due_date) : null;
  if (due && !due.startsWith(input.month + "-"))
    throw new UserError("O vencimento precisa ser deste mês.");
  const id = input.id ?? randomUUID();
  if (input.id) {
    const result = await tx.query(
      `UPDATE monthly_items SET label=$1,planned_cents=$2,due_date=$3,notes=$4,category_id=$5,cost_type=CASE WHEN $12::boolean THEN $13::text ELSE cost_type END,version=version+1,updated_at=now() WHERE id=$6 AND household_id=$7 AND version=$8 AND month=$9 AND currency=$10 AND purpose=$11 AND NOT archived RETURNING id`,
      [
        input.label,
        amount,
        due,
        input.notes,
        input.category_id,
        id,
        user.familyId,
        input.version,
        month,
        input.currency,
        input.purpose,
        input.cost_type !== undefined,
        input.cost_type ?? null,
      ],
    );
    if (!result.rows.length)
      throw new UserError(
        "O item mudou no outro aparelho. Atualize antes de salvar.",
      );
  } else
    await tx.query(
      `INSERT INTO monthly_items(id,household_id,month,label,purpose,currency,planned_cents,due_date,category_id,notes,created_by,cost_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        user.familyId,
        month,
        input.label,
        input.purpose,
        input.currency,
        amount,
        due,
        input.category_id,
        input.notes,
        user.userId,
        input.cost_type ?? null,
      ],
    );
  await recordAudit(tx, user.familyId, user.userId, "routine.save", id);
  return { id };
}
export async function checkItem(db: Database, user: Identity, raw: unknown) {
  return asUser(db, user.userId, (tx) => checkItemTx(tx, user, raw));
}
export async function checkItemTx(
  tx: Transaction,
  user: Identity,
  raw: unknown,
) {
  const input = z
    .object({
      id: z.uuid(),
      version: z.number().int().positive(),
      status: z.enum(["open", "done", "partial"]),
      amount: z.string().nullable().default(null),
      date: z.string().nullable().default(null),
      event_id: z.uuid().nullable().default(null),
    })
    .strict()
    .parse(raw);
  const date = input.date ? dateOnly(input.date) : null;
  const amount = input.amount ? cents(input.amount) : null;
  if (amount !== null && amount < 0n)
    throw new UserError("Informe um valor positivo.");
  const item = (
    await tx.query<MonthlyItem>(
      "SELECT *,planned_cents::text FROM monthly_items WHERE household_id=$1 AND id=$2 AND NOT archived FOR UPDATE",
      [user.familyId, input.id],
    )
  ).rows[0];
  if (!item || item.version !== input.version)
    throw new UserError("O item mudou no outro aparelho. Atualize sua lista.");
  if (input.event_id) {
    const event = (
      await tx.query<{ currency: string; kind: string }>(
        "SELECT currency,kind FROM economic_events WHERE household_id=$1 AND id=$2",
        [user.familyId, input.event_id],
      )
    ).rows[0];
    const allowed =
      item.purpose === "income"
        ? ["income", "yield"]
        : item.purpose === "card"
          ? ["card_payment"]
          : item.purpose === "saving"
            ? ["transfer", "investment_buy"]
            : ["expense", "fee", "card_purchase"];
    if (
      !event ||
      event.currency !== item.currency ||
      !allowed.includes(event.kind)
    )
      throw new UserError("Esse movimento não corresponde ao compromisso.");
    const duplicate = await tx.query(
      "SELECT id FROM monthly_items WHERE household_id=$1 AND event_id=$2 AND id<>$3 AND NOT archived",
      [user.familyId, input.event_id, item.id],
    );
    if (duplicate.rows.length)
      throw new UserError(
        "Esse movimento já está vinculado a outra conta do mês.",
      );
  }
  // Checklist is a plan, never a second copy of the bank transaction.
  await tx.query(
    `UPDATE monthly_items SET status=$1,paid_cents=$2,paid_date=$3,event_id=$4,version=version+1,updated_at=now() WHERE id=$5`,
    [
      input.status,
      input.status === "open"
        ? null
        : (amount?.toString() ??
          (input.status === "done" ? item.planned_cents : null)),
      input.status === "open" ? null : date,
      input.status === "open" ? null : input.event_id,
      item.id,
    ],
  );
  await recordAudit(tx, user.familyId, user.userId, "routine.check", item.id, {
    status: input.status,
    no_new_financial_event: true,
  });
  return { ok: true };
}
export async function copyMonth(db: Database, user: Identity, raw: unknown) {
  const input = z
    .object({
      from: z.string().regex(/^\d{4}-\d{2}$/),
      to: z.string().regex(/^\d{4}-\d{2}$/),
    })
    .strict()
    .parse(raw);
  dateOnly(input.from + "-01");
  dateOnly(input.to + "-01");
  if (input.from === input.to) throw new UserError("Selecione outro mês.");
  return asUser(db, user.userId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "bank-analysis:" + user.familyId,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.familyId + input.to,
    ]);
    if (
      (
        await tx.query(
          `SELECT 1 FROM monthly_items m WHERE household_id=$1 AND month=$2 AND NOT archived AND NOT (purpose='income' AND status='open' AND event_id IS NULL AND EXISTS(SELECT 1 FROM income_occurrences o WHERE o.household_id=m.household_id AND o.monthly_item_id=m.id)) LIMIT 1`,
          [user.familyId, input.to + "-01"],
        )
      ).rows.length
    )
      throw new UserError(
        "Este mês já tem planejamento. Nada foi sobrescrito.",
      );
    const items = (
      await tx.query<MonthlyItem>(
        "SELECT *,due_date::text,planned_cents::text FROM monthly_items WHERE household_id=$1 AND month=$2 AND NOT archived",
        [user.familyId, input.from + "-01"],
      )
    ).rows;
    if (!items.length) throw new UserError("O mês de origem não tem itens.");
    const last = new Date(
      Number(input.to.slice(0, 4)),
      Number(input.to.slice(5, 7)),
      0,
    ).getDate();
    for (const i of items) {
      const forecast = (
        await tx.query(
          `SELECT 1 FROM monthly_items m JOIN income_occurrences o ON o.monthly_item_id=m.id AND o.household_id=m.household_id WHERE m.household_id=$1 AND m.month=$2 AND upper(m.label)=upper($3) AND m.purpose=$4 AND NOT m.archived`,
          [user.familyId, input.to + "-01", i.label, i.purpose],
        )
      ).rows.length;
      if (forecast) continue;
      const due = i.due_date
        ? input.to +
          "-" +
          String(Math.min(Number(i.due_date.slice(8, 10)), last)).padStart(
            2,
            "0",
          )
        : null;
      await tx.query(
        `INSERT INTO monthly_items(id,household_id,month,label,purpose,currency,planned_cents,category_id,due_date,notes,created_by,cost_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          user.familyId,
          input.to + "-01",
          i.label,
          i.purpose,
          i.currency,
          i.planned_cents,
          i.category_id,
          due,
          i.notes,
          user.userId,
          i.cost_type ?? null,
        ],
      );
    }
    await recordAudit(
      tx,
      user.familyId,
      user.userId,
      "routine.copy",
      user.familyId,
      { from: input.from, to: input.to, items: items.length },
    );
    return { copied: items.length };
  });
}
