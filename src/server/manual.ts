import type { Transaction } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Identity } from "./auth.ts";
import { asUser, recordAudit, type Database } from "./db.ts";
import {
  accountFor,
  addEvent,
  refreshReconciliations,
  type StageRow,
} from "./imports.ts";
import { cents, dateOnly, kinds } from "../domain/finance.ts";
const currency = z.enum(["BRL", "USD", "EUR"]);
export async function createManualEvent(
  db: Database,
  user: Identity,
  raw: unknown,
) {
  return asUser(db, user.userId, (tx) => createManualEventTx(tx, user, raw));
}
export async function createManualEventTx(
  tx: Transaction,
  user: Identity,
  raw: unknown,
) {
  const input = z
    .object({
      account_id: z.uuid(),
      date: z.string(),
      description: z.string().min(1).max(1000),
      amount: z.string(),
      kind: z.enum(kinds),
      category_id: z.uuid().nullable(),
      counter_account_id: z.uuid().nullable(),
      counter_currency: currency.nullable(),
      counter_amount: z.string().nullable(),
      related_event_id: z.uuid().nullable(),
      request_id: z.uuid().optional(),
    })
    .strict()
    .parse(raw);
  if (input.request_id) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      user.familyId + input.request_id,
    ]);
    const existing = (
      await tx.query<{ event_id: string }>(
        "SELECT event_id FROM operation_keys WHERE household_id=$1 AND request_id=$2",
        [user.familyId, input.request_id],
      )
    ).rows[0];
    if (existing) return existing.event_id;
  }
  const account = await accountFor(tx, user.familyId, input.account_id);
  const row: StageRow = {
    id: randomUUID(),
    batch_id: "",
    ordinal: 1,
    transaction_date: dateOnly(input.date),
    processing_date: null,
    due_date: null,
    original_description: input.description,
    description: input.description,
    amount_cents: cents(input.amount).toString(),
    currency: account.currency,
    bank_id: null,
    suggested_kind: input.kind,
    kind: input.kind,
    category_id: input.category_id,
    counter_account_id: input.counter_account_id,
    counter_currency: input.counter_currency,
    counter_amount_cents: input.counter_amount
      ? cents(input.counter_amount).toString()
      : null,
    related_event_id: input.related_event_id,
    link_event_id: null,
    decision: "accept",
    reviewed: true,
    duplicate_hint: false,
    review_note: "Lançamento manual",
    version: 1,
    locator: "manual",
    confidence: 1,
  };
  const event = await addEvent(tx, user, account, row);
  if (input.request_id)
    await tx.query(
      "INSERT INTO operation_keys(household_id,request_id,event_id) VALUES($1,$2,$3)",
      [user.familyId, input.request_id, event],
    );
  await refreshReconciliations(tx, user.familyId);
  await recordAudit(
    tx,
    user.familyId,
    user.userId,
    "transaction.create",
    event,
  );
  return event;
}
