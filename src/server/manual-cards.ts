import { z } from "zod";
import { asUser, recordAudit, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { cents, dateOnly } from "../domain/finance.ts";
import { UserError } from "./imports.ts";

// A bill is a liability reminder, never a second expense or a bank posting.
export async function saveManualCard(db: Database, u: Identity, raw: unknown) {
  if (!["owner", "editor"].includes(u.role))
    throw new UserError("Seu acesso é somente para leitura.");
  const v = z
    .object({
      account_id: z.uuid(),
      month: z.string().regex(/^\d{4}-\d{2}$/),
      limit: z.string().max(30),
      amount: z.string().max(30),
      due_date: z.string().max(10),
      paid: z.boolean(),
    })
    .strict()
    .parse(raw);
  dateOnly(v.month + "-01");
  const amount = v.amount.trim() ? cents(v.amount) : null,
    limit = v.limit.trim() ? cents(v.limit) : null;
  if ((amount !== null && amount < 0n) || (limit !== null && limit < 0n))
    throw new UserError("Use valores iguais ou maiores que zero.");
  if ((amount === null) !== !v.due_date)
    throw new UserError("Informe o valor da fatura e seu vencimento juntos.");
  if (v.paid && amount === null)
    throw new UserError("Informe a fatura antes de marcar como paga.");
  if (v.due_date) {
    dateOnly(v.due_date);
    if (!v.due_date.startsWith(v.month + "-"))
      throw new UserError("O vencimento deve pertencer ao mês escolhido.");
  }
  return asUser(db, u.userId, async (tx) => {
    const account = (
      await tx.query(
        "SELECT id FROM accounts WHERE id=$1 AND household_id=$2 AND kind='card' AND currency='BRL' FOR UPDATE",
        [v.account_id, u.familyId],
      )
    ).rows[0];
    if (!account) throw new UserError("Escolha um cartão da família em reais.");
    if (
      (
        await tx.query(
          "SELECT id FROM bank_accounts WHERE household_id=$1 AND local_account_id=$2 AND account_type='CREDIT' AND active",
          [u.familyId, v.account_id],
        )
      ).rows.length
    )
      throw new UserError(
        "Este cartão já recebe dados do banco. Confira a integração para evitar informações sobrepostas.",
      );
    await tx.query(
      `INSERT INTO manual_card_settings(household_id,account_id,limit_cents,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(household_id,account_id) DO UPDATE SET limit_cents=excluded.limit_cents,updated_by=excluded.updated_by,updated_at=now()`,
      [u.familyId, v.account_id, limit?.toString() ?? null, u.userId],
    );
    if (amount !== null)
      await tx.query(
        `INSERT INTO manual_card_bills(household_id,account_id,month,amount_cents,due_date,paid,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(household_id,account_id,month) DO UPDATE SET amount_cents=excluded.amount_cents,due_date=excluded.due_date,paid=excluded.paid,updated_by=excluded.updated_by,updated_at=now()`,
        [
          u.familyId,
          v.account_id,
          v.month + "-01",
          amount.toString(),
          v.due_date,
          v.paid,
          u.userId,
        ],
      );
    await recordAudit(tx, u.familyId, u.userId, "card.manual", v.account_id, {
      month: v.month,
      source: "family",
      bill_updated: amount !== null,
      financial_events_created: 0,
    });
    return { ok: true };
  });
}
