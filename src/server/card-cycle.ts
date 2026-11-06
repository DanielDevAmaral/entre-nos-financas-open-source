import { z } from "zod";
import { asUser, recordAudit, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { dateOnly } from "../domain/finance.ts";
import { UserError } from "./imports.ts";
export async function saveCardCycle(db: Database, u: Identity, raw: unknown) {
  if (!["owner", "editor"].includes(u.role))
    throw new UserError("Seu acesso é somente para leitura.");
  const v = z
    .object({
      account_id: z.uuid(),
      close_date: z.string().max(10),
      due_date: z.string().max(10),
    })
    .strict()
    .parse(raw);
  dateOnly(v.close_date);
  dateOnly(v.due_date);
  const [cy, cm] = v.close_date.split("-").map(Number),
    [dy, dm] = v.due_date.split("-").map(Number),
    offset = (dy - cy) * 12 + dm - cm;
  if (v.due_date <= v.close_date || ![0, 1].includes(offset))
    throw new UserError(
      "O vencimento deve ser após o fechamento, no mesmo mês ou no seguinte.",
    );
  return asUser(db, u.userId, async (tx) => {
    const account = (
      await tx.query(
        "SELECT id FROM accounts WHERE id=$1 AND household_id=$2 AND kind='card'",
        [v.account_id, u.familyId],
      )
    ).rows[0];
    if (!account) throw new UserError("Escolha um cartão da família.");
    await tx.query(
      `INSERT INTO card_cycles(household_id,account_id,closing_day,due_day,due_month_offset,effective_close_date,effective_due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(household_id,account_id) DO UPDATE SET closing_day=excluded.closing_day,due_day=excluded.due_day,due_month_offset=excluded.due_month_offset,effective_close_date=excluded.effective_close_date,effective_due_date=excluded.effective_due_date,updated_at=now()`,
      [
        u.familyId,
        v.account_id,
        Number(v.close_date.slice(8)),
        Number(v.due_date.slice(8)),
        offset,
        v.close_date,
        v.due_date,
        u.userId,
      ],
    );
    await recordAudit(tx, u.familyId, u.userId, "card.cycle", v.account_id, {
      close_date: v.close_date,
      due_date: v.due_date,
      source: "family",
      financial_events_created: 0,
    });
    return { ok: true };
  });
}
