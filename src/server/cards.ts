import { cardCyclePeriod } from "../domain/card-cycle.ts";
import type { Database } from "./db.ts";
import { asUser } from "./db.ts";
import type { Identity } from "./auth.ts";
import { dateOnly } from "../domain/finance.ts";

export async function readCards(db: Database, u: Identity, month: string) {
  dateOnly(month + "-01");
  return asUser(db, u.userId, async (tx) => {
    const accounts = (
      await tx.query<{
        id: string;
        connected: boolean;
        local_account_id: string;
        name: string;
        last_four: string;
        balance_cents: string | null;
        credit_due_date: string | null;
        credit_close_date: string | null;
        read_at: string;
        bills_read_ok: boolean | null;
        credit_limit_cents: string | null;
        available_credit_cents: string | null;
        credit_limits_review: boolean;
      }>(
        `SELECT ba.id,true AS connected,ba.local_account_id,a.name,ba.last_four,ba.balance_cents::text,ba.credit_due_date::text,ba.credit_close_date::text,ba.read_at::text,ba.bills_read_ok,ba.credit_limit_cents::text,ba.available_credit_cents::text,ba.credit_limits_review FROM bank_accounts ba JOIN accounts a ON a.id=ba.local_account_id WHERE ba.household_id=$1 AND ba.account_type='CREDIT' AND ba.active ORDER BY a.name`,
        [u.familyId],
      )
    ).rows;
    const unconnected = (
      await tx.query<{ id: string; name: string }>(
        `SELECT a.id,a.name FROM accounts a WHERE a.household_id=$1 AND a.kind='card' AND NOT EXISTS(SELECT 1 FROM bank_accounts ba WHERE ba.household_id=a.household_id AND ba.local_account_id=a.id AND ba.account_type='CREDIT' AND ba.active) ORDER BY a.name`,
        [u.familyId],
      )
    ).rows;
    for (const a of unconnected)
      accounts.push({
        id: a.id,
        connected: false,
        local_account_id: a.id,
        name: a.name,
        last_four: "",
        balance_cents: null,
        credit_due_date: null,
        credit_close_date: null,
        read_at: "",
        bills_read_ok: null,
        credit_limit_cents: null,
        available_credit_cents: null,
        credit_limits_review: false,
      });
    const bills = (
      await tx.query<{
        id: string;
        bank_account_id: string;
        remote_id: string;
        due_date: string;
        close_date: string | null;
        total_cents: string | null;
        raw_total: string;
        needs_review: boolean;
        read_at: string;
      }>(
        `SELECT id,bank_account_id,remote_id,due_date::text,close_date::text,total_cents::text,raw_total,needs_review,read_at::text FROM bank_card_bills WHERE household_id=$1 AND due_date>=$2::date AND due_date<($2::date+interval '1 month') ORDER BY due_date`,
        [u.familyId, month + "-01"],
      )
    ).rows;
    const cycles = (
      await tx.query<{
        account_id: string;
        closing_day: number;
        due_day: number;
        due_month_offset: number;
        effective_close_date: string;
        effective_due_date: string;
      }>(
        `SELECT account_id,closing_day,due_day,due_month_offset,effective_close_date::text,effective_due_date::text FROM card_cycles WHERE household_id=$1`,
        [u.familyId],
      )
    ).rows;
    const manualSettings = (
      await tx.query<{ account_id: string; limit_cents: string | null }>(
        "SELECT account_id,limit_cents::text FROM manual_card_settings WHERE household_id=$1",
        [u.familyId],
      )
    ).rows;
    const manualBills = (
      await tx.query<{
        account_id: string;
        amount_cents: string;
        due_date: string;
        paid: boolean;
      }>(
        "SELECT account_id,amount_cents::text,due_date::text,paid FROM manual_card_bills WHERE household_id=$1 AND month=$2::date",
        [u.familyId, month + "-01"],
      )
    ).rows;
    const rows = (
      await tx.query<{
        id: string;
        bank_account_id: string;
        transaction_date: string;
        description: string;
        amount_cents: string;
        provider_status: string;
        status: string;
        event_id: string | null;
        changed: boolean;
        missing: boolean;
        operation_type: string;
        card_meta: {
          bill_id?: string;
          installment_number?: number;
          total_installments?: number;
        };
        analysis: { group?: string; category_suggestion?: string };
      }>(
        `SELECT b.id,b.bank_account_id,b.transaction_date::text,b.description,b.amount_cents::text,b.provider_status,b.status,b.event_id,b.changed,b.missing,b.operation_type,b.card_meta,b.analysis FROM bank_transactions b JOIN bank_accounts a ON a.id=b.bank_account_id WHERE b.household_id=$1 AND a.account_type='CREDIT' AND (b.transaction_date>=($2::date-interval '2 months') AND b.transaction_date<($2::date+interval '1 month') OR b.card_meta->>'bill_id' IN (SELECT remote_id::text FROM bank_card_bills WHERE household_id=$1 AND due_date>=$2::date AND due_date<($2::date+interval '1 month'))) ORDER BY b.transaction_date DESC,b.id`,
        [u.familyId, month + "-01"],
      )
    ).rows;
    const registered = (
      await tx.query<{ account_id: string; cents: string }>(
        `SELECT l.account_id,(-sum(l.amount_cents))::text AS cents FROM ledger_entries l JOIN economic_events e ON e.id=l.event_id JOIN accounts a ON a.id=l.account_id WHERE e.household_id=$1 AND a.kind='card' AND e.kind IN ('card_purchase','expense','fee','refund') AND e.transaction_date>=$2::date AND e.transaction_date<($2::date+interval '1 month') GROUP BY l.account_id`,
        [u.familyId, month + "-01"],
      )
    ).rows;
    return accounts.map((a) => {
      const observations = rows.filter(
        (r) => r.bank_account_id === a.id && r.status !== "ignored",
      );
      const purchases = observations.filter(
        (r) =>
          BigInt(r.amount_cents) < 0n &&
          !/PAGAMENTO_FATURA/i.test(r.operation_type) &&
          !/PAGAMENTO.*FATURA/i.test(r.description),
      );
      const payments = observations.filter(
        (r) =>
          BigInt(r.amount_cents) > 0n &&
          (/PAGAMENTO_FATURA/i.test(r.operation_type) ||
            /PAGAMENTO.*(FATURA|RECEBIDO)/i.test(r.description)),
      );
      const current = purchases.filter((r) =>
        r.transaction_date.startsWith(month),
      );
      const sum = (rs: typeof purchases) =>
        rs
          .reduce(
            (n, r) =>
              n +
              (BigInt(r.amount_cents) < 0n
                ? -BigInt(r.amount_cents)
                : BigInt(r.amount_cents)),
            0n,
          )
          .toString();
      const cycle = cycles.find((c) => c.account_id === a.local_account_id);
      const period =
        cycle && month >= cycle.effective_due_date.slice(0, 7)
          ? cardCyclePeriod(
              month,
              cycle.closing_day,
              cycle.due_day,
              cycle.due_month_offset,
            )
          : null;
      const estimatedPurchases = period
        ? purchases.filter(
            (r) =>
              !r.card_meta.bill_id &&
              r.transaction_date >= period.start_date &&
              r.transaction_date <= period.close_date &&
              !r.changed &&
              !r.missing &&
              r.analysis.group !== "duplicate",
          )
        : [];
      const projection = period
        ? {
            ...period,
            total_cents: sum(estimatedPurchases),
            purchase_count: estimatedPurchases.length,
            bank_pending_count: estimatedPurchases.filter(
              (r) => r.provider_status !== "POSTED",
            ).length,
            closing_day_count: estimatedPurchases.filter(
              (r) => r.transaction_date === period.close_date,
            ).length,
            purchase_ids: estimatedPurchases.map((r) => r.id),
          }
        : null;
      return {
        ...a,
        manual_limit_cents:
          manualSettings.find((s) => s.account_id === a.local_account_id)
            ?.limit_cents ?? null,
        manual_bill:
          manualBills.find((b) => b.account_id === a.local_account_id) ?? null,
        cycle: cycle ?? null,
        projection,
        committed_credit_cents:
          !a.credit_limits_review &&
          a.credit_limit_cents !== null &&
          a.available_credit_cents !== null
            ? (
                BigInt(a.credit_limit_cents) - BigInt(a.available_credit_cents)
              ).toString()
            : null,
        bills: bills
          .filter((b) => b.bank_account_id === a.id)
          .map((b) => ({
            ...b,
            assigned_purchase_cents: sum(
              purchases.filter((r) => r.card_meta.bill_id === b.remote_id),
            ),
            assigned_count: purchases.filter(
              (r) => r.card_meta.bill_id === b.remote_id,
            ).length,
          })),
        unassigned_cents: sum(
          purchases.filter(
            (r) =>
              !r.card_meta.bill_id &&
              !projection?.purchase_ids.includes(r.id) &&
              !r.transaction_date.startsWith(month) &&
              !r.event_id &&
              !r.changed &&
              !r.missing,
          ),
        ),
        purchases,
        payments,
        registered_cents:
          registered.find((r) => r.account_id === a.local_account_id)?.cents ??
          "0",
        history_match_cents: sum(
          current.filter(
            (r) =>
              !r.event_id &&
              r.analysis.group === "history" &&
              !r.changed &&
              !r.missing,
          ),
        ),
        duplicate_cents: sum(
          current.filter(
            (r) =>
              !r.event_id &&
              r.analysis.group === "duplicate" &&
              !r.changed &&
              !r.missing,
          ),
        ),
        preview_cents: sum(
          current.filter(
            (r) =>
              !r.event_id &&
              !["history", "duplicate"].includes(r.analysis.group ?? "") &&
              r.provider_status === "POSTED" &&
              !r.changed &&
              !r.missing,
          ),
        ),
        bank_pending_cents: sum(
          current.filter(
            (r) =>
              !r.event_id &&
              r.provider_status !== "POSTED" &&
              !r.changed &&
              !r.missing,
          ),
        ),
        review_count: observations.filter(
          (r) => !r.event_id || r.changed || r.missing,
        ).length,
      };
    });
  });
}
