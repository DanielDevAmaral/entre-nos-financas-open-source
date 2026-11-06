import { asUser, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { dateOnly } from "../domain/finance.ts";

export async function readInvestments(
  db: Database,
  user: Identity,
  month: string,
) {
  dateOnly(month + "-01");
  return asUser(db, user.userId, async (tx) => {
    const positions = (
      await tx.query<{
        id: string;
        name: string;
        currency: string;
        opening_date: string | null;
        calculated_cents: string | null;
        last_date: string | null;
        observed_cents: string | null;
        observed_date: string | null;
      }>(
        `SELECT a.id,a.name,a.currency,a.opening_date::text,
      CASE WHEN a.opening_cents IS NOT NULL AND a.opening_date<($2::date+interval '1 month')
        THEN (a.opening_cents+coalesce(sum(l.amount_cents),0))::text ELSE NULL END AS calculated_cents,
      max(l.transaction_date)::text AS last_date, o.cents AS observed_cents,o.date AS observed_date
      FROM accounts a LEFT JOIN ledger_entries l ON l.account_id=a.id AND l.transaction_date<($2::date+interval '1 month')
      LEFT JOIN LATERAL (SELECT b.context->'closing'->>'cents' AS cents,b.context->'closing'->>'date' AS date
        FROM import_batches b WHERE b.household_id=a.household_id AND b.account_id=a.id
        AND b.context->'closing'->>'date'<to_char(($2::date+interval '1 month'),'YYYY-MM-DD')
        AND b.context->'closing'->>'cents' IS NOT NULL AND jsonb_array_length(b.checks)>0
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.checks) c WHERE (c->>'passed')::boolean=false)
        ORDER BY b.context->'closing'->>'date' DESC LIMIT 1) o ON true
      WHERE a.household_id=$1 AND a.kind='investment'
      GROUP BY a.id,o.cents,o.date ORDER BY a.currency,a.name`,
        [user.familyId, month + "-01"],
      )
    ).rows;
    const movements = (
      await tx.query<{
        kind: string;
        currency: string;
        amount_cents: string;
        count: number;
      }>(
        `SELECT kind,currency,sum(abs(amount_cents))::text AS amount_cents,count(*)::integer AS count
       FROM economic_events WHERE household_id=$1 AND transaction_date>=$2::date
       AND transaction_date<($2::date+interval '1 month') AND kind IN ('investment_buy','investment_sell','yield')
       GROUP BY kind,currency ORDER BY currency,kind`,
        [user.familyId, month + "-01"],
      )
    ).rows;
    return { month, positions, movements };
  });
}
