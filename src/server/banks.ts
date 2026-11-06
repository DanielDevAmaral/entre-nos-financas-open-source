import { analyzeBanksTx, readIncomeRules } from "./bank-analysis.ts";
import { reviewGroups, type Analysis } from "../domain/bank-analysis.ts";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Transaction } from "@electric-sql/pglite";
import { asUser, recordAudit, type Database } from "./db.ts";
import type { Identity } from "./auth.ts";
import { dateOnly } from "../domain/finance.ts";
import { plainMoney } from "../domain/format.ts";
import { accountFor, UserError } from "./imports.ts";
import { createManualEventTx } from "./manual.ts";
import {
  PluggyReader,
  credentialsSchema,
  bankStorageReady,
  sealCredentials,
  openCredentials,
  type BankCredentials,
  type BankObservation,
  type RemoteAccount,
  type RemoteBill,
  decimalCents,
} from "./pluggy.ts";
type Factory = (credentials: BankCredentials) => PluggyReader;
const realReader: Factory = (c) => new PluggyReader(c);
const binding = (u: Identity) => u.familyId + ":" + u.userId;
function writer(u: Identity) {
  if (!["owner", "editor"].includes(u.role))
    throw new UserError("Seu acesso é somente para leitura.");
}
export function bankToday() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
}
async function credentials(db: Database, u: Identity) {
  return asUser(db, u.userId, async (tx) => {
    const row = (
      await tx.query<{ sealed: string }>(
        "SELECT sealed FROM bank_credentials WHERE household_id=$1 AND user_id=$2",
        [u.familyId, u.userId],
      )
    ).rows[0];
    if (!row)
      throw new UserError(
        "Configure seu próprio acesso ao Meu Pluggy primeiro.",
      );
    return openCredentials(row.sealed, binding(u));
  });
}
function usable(item: { status: string; consentExpiresAt?: string | null }) {
  if (item.consentExpiresAt && Date.parse(item.consentExpiresAt) <= Date.now())
    throw new UserError(
      "A autorização venceu. Renove no Meu Pluggy; os registros anteriores foram preservados.",
    );
  if (item.status !== "UPDATED")
    throw new UserError(
      "A conexão no Meu Pluggy ainda não está pronta. Confira a autorização no provedor e tente mais tarde.",
    );
}
export async function saveBankCredentials(
  db: Database,
  u: Identity,
  raw: unknown,
  factory: Factory = realReader,
) {
  writer(u);
  const input = z
    .object({
      clientId: z.string(),
      clientSecret: z.string(),
      consent: z.literal(true),
    })
    .strict()
    .parse(raw);
  const value = credentialsSchema.parse({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const sealed = sealCredentials(value, binding(u)),
    reader = factory(value);
  await reader.authenticate();
  // Replacing credentials must not strand the user's existing connections in another application.
  const old = await asUser(db, u.userId, (tx) =>
    tx.query<{ item_id: string }>(
      "SELECT item_id FROM bank_connections WHERE household_id=$1 AND user_id=$2 AND enabled",
      [u.familyId, u.userId],
    ),
  );
  for (const c of old.rows) await reader.item(c.item_id);
  await asUser(db, u.userId, async (tx) => {
    await tx.query(
      "INSERT INTO bank_credentials(household_id,user_id,sealed) VALUES($1,$2,$3) ON CONFLICT(household_id,user_id) DO UPDATE SET sealed=excluded.sealed,updated_at=now()",
      [u.familyId, u.userId, sealed],
    );
    await recordAudit(tx, u.familyId, u.userId, "bank.credentials", u.userId);
  });
  return { ok: true };
}
export async function connectBank(
  db: Database,
  u: Identity,
  raw: unknown,
  factory: Factory = realReader,
) {
  writer(u);
  const input = z
    .object({
      item_id: z.uuid(),
      label: z.string().trim().min(1).max(120),
      start_date: z.string(),
      consent: z.literal(true),
    })
    .strict()
    .parse(raw);
  const start = dateOnly(input.start_date);
  if (start > bankToday())
    throw new UserError("Escolha uma data inicial até hoje.");
  const reader = factory(await credentials(db, u));
  await reader.authenticate();
  const item = await reader.item(input.item_id);
  usable(item);
  if (item.id !== input.item_id)
    throw new UserError("Autorização bancária inconsistente.");
  const accounts = await reader.accounts(item.id),
    id = randomUUID();
  return asUser(db, u.userId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "bank-connect:" + u.familyId,
    ]);
    const existing = (
      await tx.query<{ id: string; user_id: string }>(
        "SELECT id,user_id FROM bank_connections WHERE household_id=$1 AND item_id=$2",
        [u.familyId, item.id],
      )
    ).rows[0];
    if (existing) {
      if (existing.user_id !== u.userId)
        throw new UserError(
          "Essa conexão já está vinculada ao outro titular da família.",
        );
      return { id: existing.id, alreadyConnected: true };
    }
    if (
      (
        await tx.query(
          "SELECT 1 FROM bank_connections WHERE household_id=$1 AND user_id=$2 AND enabled",
          [u.familyId, u.userId],
        )
      ).rows.length >= 5
    )
      throw new UserError(
        "O acesso pessoal permite até cinco conexões. Confira as conexões existentes.",
      );
    await tx.query(
      "INSERT INTO bank_connections(id,household_id,user_id,item_id,label,owner_label,start_date,provider_status,consent_expires_at,provider_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        id,
        u.familyId,
        u.userId,
        item.id,
        input.label,
        u.name,
        start,
        item.status,
        item.consentExpiresAt ?? null,
        item.lastUpdatedAt ?? null,
      ],
    );
    await storeAccounts(tx, u, id, accounts);
    await recordAudit(tx, u.familyId, u.userId, "bank.connect", id, {
      read_only: true,
    });
    return { id, alreadyConnected: false };
  });
}
async function storeAccounts(
  tx: Transaction,
  u: Identity,
  connection: string,
  accounts: RemoteAccount[],
) {
  for (const account of accounts) {
    const creditDue =
      account.type === "CREDIT" && account.creditData?.balanceDueDate
        ? dateOnly(account.creditData.balanceDueDate.slice(0, 10))
        : null;
    const creditClose =
      account.type === "CREDIT" && account.creditData?.balanceCloseDate
        ? dateOnly(account.creditData.balanceCloseDate.slice(0, 10))
        : null;
    const limit = (v: string | null | undefined) => {
      if (v == null) return null;
      try {
        const n = decimalCents(v);
        return n >= 0n ? n.toString() : null;
      } catch {
        return null;
      }
    };
    const totalLimit =
        account.type === "CREDIT"
          ? limit(account.creditData?.creditLimit)
          : null,
      availableLimit =
        account.type === "CREDIT"
          ? limit(account.creditData?.availableCreditLimit)
          : null;
    const limitEvidence =
      account.type === "CREDIT"
        ? {
            total: account.creditData?.creditLimit ?? null,
            available: account.creditData?.availableCreditLimit ?? null,
          }
        : {};
    const limitsReview =
      account.type === "CREDIT" &&
      ((account.creditData?.creditLimit != null && totalLimit === null) ||
        (account.creditData?.availableCreditLimit != null &&
          availableLimit === null) ||
        (totalLimit !== null &&
          availableLimit !== null &&
          BigInt(availableLimit) > BigInt(totalLimit)));
    const balance =
      account.currencyCode === "BRL" &&
      account.balance !== null &&
      account.balance !== undefined
        ? decimalCents(account.balance).toString()
        : null;
    const old = (
      await tx.query<{ currency: string; account_type: string }>(
        "SELECT currency,account_type FROM bank_accounts WHERE connection_id=$1 AND remote_id=$2",
        [connection, account.id],
      )
    ).rows[0];
    if (
      old &&
      (old.currency !== account.currencyCode ||
        old.account_type !== account.type)
    )
      throw new UserError(
        "O tipo ou a moeda de uma conta mudou no banco. Revise o vínculo antes de continuar.",
      );
    await tx.query(
      "INSERT INTO bank_accounts(id,household_id,connection_id,remote_id,label,last_four,currency,account_type,balance_cents,credit_due_date,credit_close_date,credit_limit_cents,available_credit_cents,credit_limits_review,credit_limits_evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(connection_id,remote_id) DO UPDATE SET label=excluded.label,last_four=excluded.last_four,balance_cents=excluded.balance_cents,active=true,read_at=now(),credit_due_date=excluded.credit_due_date,credit_close_date=excluded.credit_close_date,credit_limit_cents=excluded.credit_limit_cents,available_credit_cents=excluded.available_credit_cents,credit_limits_review=excluded.credit_limits_review,credit_limits_evidence=excluded.credit_limits_evidence",
      [
        randomUUID(),
        u.familyId,
        connection,
        account.id,
        account.name,
        (account.number ?? "").replace(/[^0-9]/g, "").slice(-4),
        account.currencyCode,
        account.type,
        balance,
        creditDue,
        creditClose,
        totalLimit,
        availableLimit,
        limitsReview,
        JSON.stringify(limitEvidence),
      ],
    );
  }
}
export async function mapBankAccount(db: Database, u: Identity, raw: unknown) {
  writer(u);
  const input = z
    .object({
      id: z.uuid(),
      account_id: z.uuid().nullable(),
      name: z.string().trim().min(1).max(120).optional(),
    })
    .strict()
    .parse(raw);
  return asUser(db, u.userId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "bank-map:" + u.familyId,
    ]);
    const remote = (
      await tx.query<{
        id: string;
        currency: string;
        account_type: string;
        local_account_id: string | null;
      }>(
        "SELECT a.* FROM bank_accounts a JOIN bank_connections c ON c.id=a.connection_id WHERE a.id=$1 AND a.household_id=$2 AND c.user_id=$3 AND c.enabled FOR UPDATE OF a",
        [input.id, u.familyId, u.userId],
      )
    ).rows[0];
    if (!remote) throw new UserError("Conta indisponível para esse acesso.");
    if (remote.local_account_id && remote.local_account_id === input.account_id)
      return { ok: true };
    if (remote.local_account_id)
      throw new UserError(
        "Este vínculo já possui histórico. Não troque a conta sem revisar a conciliação.",
      );
    let targetId = input.account_id;
    if (!targetId) {
      if (!input.name) throw new UserError("Dê um nome para a nova conta.");
      if (remote.currency !== "BRL")
        throw new UserError("Somente contas em reais podem ser vinculadas.");
      targetId = randomUUID();
      await tx.query(
        "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,$3,'Meu Pluggy','BRL',$4,$5)",
        [
          targetId,
          u.familyId,
          input.name,
          remote.account_type === "CREDIT" ? "card" : "checking",
          u.userId,
        ],
      );
    }
    const local = await accountFor(tx, u.familyId, targetId);
    if (
      local.currency !== "BRL" ||
      remote.currency !== "BRL" ||
      (remote.account_type === "CREDIT"
        ? local.kind !== "card"
        : !["checking", "benefit"].includes(local.kind))
    )
      throw new UserError(
        "Escolha uma conta existente em reais, do mesmo tipo. Cartões devem apontar para um cartão.",
      );
    if (
      (
        await tx.query(
          "SELECT id FROM bank_accounts WHERE household_id=$1 AND local_account_id=$2",
          [u.familyId, local.id],
        )
      ).rows.length
    )
      throw new UserError(
        "Essa conta já tem um vínculo bancário. Revise o vínculo anterior para não duplicar a conexão.",
      );
    await tx.query(
      "UPDATE bank_accounts SET local_account_id=$1 WHERE id=$2 AND household_id=$3",
      [local.id, remote.id, u.familyId],
    );
    await recordAudit(tx, u.familyId, u.userId, "bank.map", remote.id, {
      account_id: local.id,
    });
    return { ok: true };
  });
}
type Connection = {
  id: string;
  item_id: string;
  user_id: string;
  start_date: string;
  enabled: boolean;
};
export async function pauseBank(db: Database, u: Identity, raw: unknown) {
  writer(u);
  const input = z
    .object({ id: z.uuid(), enabled: z.boolean() })
    .strict()
    .parse(raw);
  return asUser(db, u.userId, async (tx) => {
    const result = await tx.query(
      "UPDATE bank_connections SET enabled=$1,lease_until=NULL,lease_token=NULL WHERE id=$2 AND household_id=$3 AND user_id=$4 RETURNING id",
      [input.enabled, input.id, u.familyId, u.userId],
    );
    if (!result.rows.length)
      throw new UserError("Conexão indisponível para esse acesso.");
    await recordAudit(tx, u.familyId, u.userId, "bank.pause", input.id, {
      enabled: input.enabled,
    });
    return { ok: true };
  });
}
export async function syncBank(
  db: Database,
  u: Identity,
  raw: unknown,
  factory: Factory = realReader,
) {
  writer(u);
  const input = z
      .object({ id: z.uuid(), force: z.boolean().default(false) })
      .strict()
      .parse(raw),
    token = randomUUID();
  const connection = await asUser(db, u.userId, async (tx) => {
    return (
      await tx.query<Connection>(
        "UPDATE bank_connections SET lease_until=now()+interval '2 minutes',lease_token=$1,last_attempt_at=now(),error_code=NULL WHERE id=$2 AND household_id=$3 AND user_id=$4 AND enabled AND (lease_until IS NULL OR lease_until<now()) AND (last_attempt_at IS NULL OR last_attempt_at<now()-interval '1 minute') AND ($5::boolean OR last_read_at IS NULL OR last_read_at<now()-interval '24 hours') RETURNING id,item_id,user_id,start_date::text,enabled",
        [token, input.id, u.familyId, u.userId, input.force],
      )
    ).rows[0];
  });
  if (!connection) return { skipped: true, observed: 0 };
  try {
    const reader = factory(await credentials(db, u));
    await reader.authenticate();
    const item = await reader.item(connection.item_id);
    usable(item);
    if (item.id !== connection.item_id)
      throw new UserError("Autorização bancária inconsistente.");
    const accounts = await reader.accounts(item.id);
    const mapped = await asUser(db, u.userId, (tx) =>
      tx.query<{
        id: string;
        remote_id: string;
        local_account_id: string;
        currency: string;
      }>(
        "SELECT id,remote_id,local_account_id,currency FROM bank_accounts WHERE connection_id=$1 AND household_id=$2 AND local_account_id IS NOT NULL AND active",
        [connection.id, u.familyId],
      ),
    );
    if (mapped.rows.some((a) => !accounts.some((b) => b.id === a.remote_id)))
      throw new UserError(
        "Uma conta vinculada não foi retornada pelo banco. Os registros anteriores foram preservados; confira a autorização.",
      );
    const snapshots: {
      id: string;
      local_account_id: string;
      rows: BankObservation[];
      bills: RemoteBill[] | null;
    }[] = [];
    for (const mappedAccount of mapped.rows) {
      const remote = accounts.find((a) => a.id === mappedAccount.remote_id)!;
      if (remote.currencyCode !== mappedAccount.currency)
        throw new UserError(
          "A moeda da conta mudou no banco. Revise o vínculo.",
        );
      const rows = await reader.transactions(remote, connection.start_date);
      if (rows.some((r) => r.currency !== "BRL"))
        throw new UserError(
          "Há movimentos em outra moeda nessa conta. Mantenha-os como referência e revise no banco antes de continuar.",
        );
      let bills: RemoteBill[] | null = null;
      if (remote.type === "CREDIT") {
        try {
          bills = await reader.bills(remote);
        } catch {
          bills = null;
        }
      }
      snapshots.push({
        id: mappedAccount.id,
        local_account_id: mappedAccount.local_account_id,
        rows,
        bills,
      });
    }
    const observed = await asUser(db, u.userId, async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "bank-analysis:" + u.familyId,
      ]);
      const held = (
        await tx.query(
          "SELECT id FROM bank_connections WHERE id=$1 AND household_id=$2 AND user_id=$3 AND enabled AND lease_token=$4 FOR UPDATE",
          [connection.id, u.familyId, u.userId, token],
        )
      ).rows[0];
      if (!held)
        throw new UserError(
          "A conexão foi pausada durante a leitura. Tente novamente quando estiver ativa.",
        );
      await storeAccounts(tx, u, connection.id, accounts);
      let count = 0;
      for (const s of snapshots) {
        count += await storeObservations(
          tx,
          u,
          s.id,
          s.local_account_id,
          s.rows,
          token,
        );
      }
      await tx.query(
        "UPDATE bank_connections SET last_read_at=now(),provider_status=$1,consent_expires_at=$2,provider_updated_at=$3,lease_until=NULL,lease_token=NULL,error_code=NULL WHERE id=$4",
        [
          item.status,
          item.consentExpiresAt ?? null,
          item.lastUpdatedAt ?? null,
          connection.id,
        ],
      );
      for (const snapshot of snapshots) {
        await tx.query(
          "UPDATE bank_accounts SET bills_read_at=now(),bills_read_ok=$1 WHERE id=$2 AND household_id=$3",
          [snapshot.bills !== null, snapshot.id, u.familyId],
        );
        for (const b of snapshot.bills ?? [])
          await tx.query(
            `INSERT INTO bank_card_bills(id,household_id,bank_account_id,remote_id,due_date,close_date,total_cents,currency,charges_cents,payments,raw_total,needs_review) VALUES($1,$2,$3,$4,$5,$6,$7,'BRL',$8,$9,$10,$11) ON CONFLICT(bank_account_id,remote_id) DO UPDATE SET due_date=excluded.due_date,close_date=excluded.close_date,total_cents=excluded.total_cents,charges_cents=excluded.charges_cents,payments=excluded.payments,raw_total=excluded.raw_total,needs_review=excluded.needs_review,read_at=now()`,
            [
              randomUUID(),
              u.familyId,
              snapshot.id,
              b.remote_id,
              b.due_date,
              b.close_date,
              b.total_cents,
              b.charges_cents,
              JSON.stringify(b.payments),
              b.raw_total,
              b.needs_review,
            ],
          );
      }
      await analyzeBanksTx(tx, u);
      await recordAudit(tx, u.familyId, u.userId, "bank.read", connection.id, {
        observed: count,
        financial_events_created: 0,
      });
      return count;
    });
    return { skipped: false, observed };
  } catch (e) {
    await asUser(db, u.userId, (tx) =>
      tx.query(
        "UPDATE bank_connections SET lease_until=NULL,lease_token=NULL,error_code='READ_FAILED' WHERE id=$1 AND household_id=$2 AND user_id=$3 AND lease_token=$4",
        [connection.id, u.familyId, u.userId, token],
      ),
    );
    if (e instanceof UserError) throw e;
    throw new UserError(
      "A resposta bancária precisa de revisão. Nenhum movimento foi confirmado.",
    );
  }
}
function observationHash(row: BankObservation) {
  const { provider_status: status, card_meta: metadata, ...core } = row;
  void metadata;
  void status;
  return createHash("sha256").update(JSON.stringify(core)).digest("hex");
}
async function storeObservations(
  tx: Transaction,
  u: Identity,
  bankAccount: string,
  local: string,
  rows: BankObservation[],
  run: string,
) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.remote_id))
      throw new UserError(
        "O banco repetiu um identificador na mesma leitura. Tente mais tarde.",
      );
    seen.add(row.remote_id);
    const hash = observationHash(row);
    await tx.query(
      `INSERT INTO bank_transactions(id,household_id,bank_account_id,local_account_id,remote_id,provider_id,transaction_date,description,amount_cents,currency,provider_status,operation_type,payload_hash,last_seen_run,card_meta)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$16)
   ON CONFLICT(bank_account_id,remote_id) DO UPDATE SET latest_snapshot=CASE WHEN bank_transactions.payload_hash<>excluded.payload_hash THEN $15::jsonb ELSE NULL END,
   changed=(bank_transactions.payload_hash<>excluded.payload_hash OR (bank_transactions.status IN ('linked','recorded') AND excluded.provider_status<>'POSTED')),
   provider_status=excluded.provider_status,card_meta=excluded.card_meta,missing=false,last_seen_run=excluded.last_seen_run,
   version=bank_transactions.version+CASE WHEN bank_transactions.payload_hash<>excluded.payload_hash OR bank_transactions.provider_status<>excluded.provider_status OR bank_transactions.missing THEN 1 ELSE 0 END,updated_at=now()`,
      [
        randomUUID(),
        u.familyId,
        bankAccount,
        local,
        row.remote_id,
        row.provider_id,
        row.transaction_date,
        row.description,
        row.amount_cents,
        row.currency,
        row.provider_status,
        row.operation_type,
        hash,
        run,
        JSON.stringify(row),
        JSON.stringify(row.card_meta ?? {}),
      ],
    );
  }
  // A reviewed duplicate from a renewed connection continues to substantiate its original.
  await tx.query(
    "UPDATE bank_transactions original SET last_seen_run=$1,missing=false FROM bank_transactions duplicate WHERE duplicate.household_id=$2 AND duplicate.bank_account_id=$3 AND duplicate.last_seen_run=$1 AND duplicate.duplicate_of=original.id AND NOT duplicate.changed AND duplicate.provider_status='POSTED' AND original.household_id=$2",
    [run, u.familyId, bankAccount],
  );
  // A removed observation is a reconciliation finding, never deletion of a saved event.
  await tx.query(
    "UPDATE bank_transactions SET missing=true,version=version+1 WHERE household_id=$1 AND bank_account_id=$2 AND last_seen_run<>$3 AND NOT missing AND status<>'ignored'",
    [u.familyId, bankAccount, run],
  );
  return rows.length;
}
export type BankTransaction = {
  id: string;
  bank_account_id: string;
  local_account_id: string;
  remote_id: string;
  provider_id: string | null;
  transaction_date: string;
  description: string;
  amount_cents: string;
  currency: string;
  provider_status: string;
  operation_type: string;
  status: string;
  event_id: string | null;
  version: number;
  changed: boolean;
  missing: boolean;
  latest_snapshot: BankObservation | null;
  analysis: Analysis | Record<string, never>;
  account_name: string;
  owner_label: string;
};
async function candidates(
  tx: Transaction,
  family: string,
  row: BankTransaction,
) {
  const events = (
    await tx.query<{
      id: string;
      description: string;
      kind: string;
      transaction_date: string;
      amount_cents: string;
      bank_seen: boolean;
    }>(
      `SELECT DISTINCT e.id,e.description,e.kind,e.transaction_date::text,l.amount_cents::text,EXISTS(SELECT 1 FROM bank_transactions seen WHERE seen.household_id=$1 AND seen.bank_account_id=$6 AND seen.event_id=e.id) AS bank_seen FROM ledger_entries l JOIN economic_events e ON e.id=l.event_id WHERE l.household_id=$1 AND l.account_id=$2 AND l.currency='BRL' AND ((e.transaction_date=$3 AND l.amount_cents=$4) OR ($5::text IS NOT NULL AND EXISTS(SELECT 1 FROM bank_transactions b WHERE b.household_id=$1 AND b.local_account_id=$2 AND b.provider_id=$5 AND b.event_id=e.id))) ORDER BY e.transaction_date::text DESC LIMIT 12`,
      [
        family,
        row.local_account_id,
        row.transaction_date,
        row.amount_cents,
        row.provider_id,
        row.bank_account_id,
      ],
    )
  ).rows;
  const staged = (
    await tx.query<{ id: string; description: string; filename: string }>(
      "SELECT s.id,s.description,f.filename FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id JOIN source_files f ON f.id=b.source_id WHERE s.household_id=$1 AND b.account_id=$2 AND s.transaction_date=$3 AND s.amount_cents=$4 AND s.currency='BRL' AND NOT EXISTS(SELECT 1 FROM event_sources es WHERE es.staged_id=s.id) ORDER BY s.ordinal LIMIT 12",
      [family, row.local_account_id, row.transaction_date, row.amount_cents],
    )
  ).rows;
  const transfer = (
    await tx.query<{ id: string; account_name: string; description: string }>(
      "SELECT b.id,a.name AS account_name,b.description FROM bank_transactions b JOIN accounts a ON a.id=b.local_account_id WHERE b.household_id=$1 AND b.local_account_id<>$2 AND b.currency='BRL' AND b.amount_cents=-$3::bigint AND b.transaction_date=$4 AND b.status='pending' AND NOT b.changed AND NOT b.missing ORDER BY b.id LIMIT 6",
      [family, row.local_account_id, row.amount_cents, row.transaction_date],
    )
  ).rows;
  return { events, staged, transfer };
}
export async function readBanks(
  db: Database,
  u: Identity,
  offset = 0,
  group = "",
  account = "",
) {
  if (account) z.uuid().parse(account);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000)
    throw new UserError("Página inválida.");
  if (group && !Object.hasOwn(reviewGroups, group))
    throw new UserError("Filtro inválido.");
  return asUser(db, u.userId, async (tx) => {
    const hasCredentials =
      (
        await tx.query(
          "SELECT 1 FROM bank_credentials WHERE household_id=$1 AND user_id=$2",
          [u.familyId, u.userId],
        )
      ).rows.length > 0;
    const connections = (
      await tx.query<{
        id: string;
        user_id: string;
        label: string;
        owner_label: string;
        enabled: boolean;
        provider_status: string;
        last_read_at: string | null;
        provider_updated_at: string | null;
        consent_expires_at: string | null;
        error_code: string | null;
        start_date: string;
      }>(
        "SELECT id,user_id,label,owner_label,enabled,provider_status,last_read_at::text,provider_updated_at::text,consent_expires_at::text,error_code,start_date::text FROM bank_connections WHERE household_id=$1 ORDER BY created_at",
        [u.familyId],
      )
    ).rows.map((c) => ({
      ...c,
      own: c.user_id === u.userId,
      user_id: undefined,
    }));
    const accounts = (
      await tx.query<{
        id: string;
        connection_id: string;
        label: string;
        last_four: string;
        currency: string;
        account_type: string;
        local_account_id: string | null;
        balance_cents: string | null;
        read_at: string;
      }>(
        "SELECT id,connection_id,label,last_four,currency,account_type,local_account_id,balance_cents::text,read_at::text FROM bank_accounts WHERE household_id=$1 AND active ORDER BY label",
        [u.familyId],
      )
    ).rows;
    const rows = (
      await tx.query<BankTransaction>(
        "SELECT b.id,b.bank_account_id,b.local_account_id,b.remote_id,b.provider_id,b.transaction_date::text,b.description,b.amount_cents::text,b.currency,b.provider_status,b.operation_type,b.status,b.event_id,b.version,b.changed,b.missing,b.latest_snapshot,b.analysis,a.name AS account_name,c.owner_label FROM bank_transactions b JOIN bank_accounts ba ON ba.id=b.bank_account_id JOIN bank_connections c ON c.id=ba.connection_id JOIN accounts a ON a.id=b.local_account_id WHERE b.household_id=$1 AND (b.status='pending' OR b.changed OR b.missing) AND ($3='' OR b.analysis->>'group'=$3) AND ($4::uuid IS NULL OR b.local_account_id=$4) ORDER BY b.transaction_date DESC,b.id LIMIT 31 OFFSET $2",
        [u.familyId, offset, group, account || null],
      )
    ).rows;
    const total = (
      await tx.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM bank_transactions WHERE household_id=$1 AND (status='pending' OR changed OR missing) AND ($2='' OR analysis->>'group'=$2) AND ($3::uuid IS NULL OR local_account_id=$3)",
        [u.familyId, group, account || null],
      )
    ).rows[0].count;
    const reviews = [];
    for (const row of rows.slice(0, 30))
      reviews.push({
        ...row,
        candidates: await candidates(tx, u.familyId, row),
      });
    return {
      groups: (
        await tx.query<{ group: string; count: number }>(
          "SELECT coalesce(analysis->>'group','unreviewed') AS \"group\",count(*)::integer AS count FROM bank_transactions WHERE household_id=$1 AND (status='pending' OR changed OR missing) AND ($2::uuid IS NULL OR local_account_id=$2) GROUP BY 1",
          [u.familyId, account || null],
        )
      ).rows,
      incomeRules: await readIncomeRules(tx, u.familyId),
      storageReady: bankStorageReady(),
      hasCredentials,
      connections,
      accounts,
      reviews,
      total,
      hasMore: rows.length > 30,
      offset,
    };
  });
}
export async function reviewBankTransaction(
  db: Database,
  u: Identity,
  raw: unknown,
) {
  writer(u);
  const input = z
    .object({
      id: z.uuid(),
      version: z.number().int().positive(),
      decision: z.enum(["link", "record", "ignore", "refresh"]),
      event_id: z.uuid().nullable().default(null),
      staged_id: z.uuid().nullable().default(null),
      kind: z
        .enum([
          "income",
          "expense",
          "card_purchase",
          "transfer",
          "card_payment",
          "investment_buy",
          "investment_sell",
          "fee",
          "yield",
        ])
        .optional(),
      category_id: z.uuid().nullable().default(null),
      counter_account_id: z.uuid().nullable().default(null),
      note: z.string().trim().max(1000).default(""),
      distinct: z.boolean().default(false),
      duplicate: z.boolean().default(false),
    })
    .strict()
    .parse(raw);
  return asUser(db, u.userId, async (tx) => {
    const row = (
      await tx.query<BankTransaction>(
        "SELECT *,transaction_date::text,amount_cents::text FROM bank_transactions WHERE id=$1 AND household_id=$2 FOR UPDATE",
        [input.id, u.familyId],
      )
    ).rows[0];
    if (!row) throw new UserError("Movimento indisponível.");
    if (row.version !== input.version)
      throw new UserError("O movimento mudou. Atualize antes de revisar.");
    if (row.event_id)
      throw new UserError(
        "Esse movimento já está vinculado. Alterações posteriores do banco exigem conciliação; nenhum lançamento foi modificado.",
      );
    if (input.decision === "refresh") {
      if (!row.changed || !row.latest_snapshot || row.missing)
        throw new UserError("Não há uma nova versão disponível para revisar.");
      const v = row.latest_snapshot;
      if (v.currency !== "BRL" || v.remote_id !== row.remote_id)
        throw new UserError(
          "A nova versão exige revisão de moeda ou identidade.",
        );
      await tx.query(
        "UPDATE bank_transactions SET provider_id=$1,transaction_date=$2,description=$3,amount_cents=$4,currency=$5,operation_type=$6,payload_hash=$7,latest_snapshot=NULL,changed=false,status='pending',version=version+1 WHERE id=$8",
        [
          v.provider_id,
          v.transaction_date,
          v.description,
          v.amount_cents,
          v.currency,
          v.operation_type,
          observationHash(v),
          row.id,
        ],
      );
    } else if (input.decision === "ignore") {
      if (input.note.length < 8)
        throw new UserError(
          "Explique por que este movimento deve ficar fora dos totais.",
        );
      await tx.query(
        "UPDATE bank_transactions SET status='ignored',changed=false,missing=false,review_note=$1,version=version+1 WHERE id=$2",
        [input.note, row.id],
      );
    } else {
      if (
        row.status !== "pending" ||
        row.changed ||
        row.missing ||
        row.provider_status !== "POSTED"
      )
        throw new UserError(
          "Aguarde a confirmação do banco e revise as alterações antes de registrar.",
        );
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "bank-event:" +
          u.familyId +
          row.local_account_id +
          row.transaction_date +
          row.amount_cents,
      ]);
      let event: string;
      if (input.decision === "link") {
        if (!input.event_id)
          throw new UserError("Escolha o movimento já existente.");
        const match = (
          await tx.query(
            "SELECT 1 FROM ledger_entries l JOIN economic_events e ON e.id=l.event_id WHERE e.id=$1 AND l.household_id=$2 AND l.account_id=$3 AND l.currency='BRL' AND l.amount_cents=$4 AND e.transaction_date=$5",
            [
              input.event_id,
              u.familyId,
              row.local_account_id,
              row.amount_cents,
              row.transaction_date,
            ],
          )
        ).rows[0];
        if (!match)
          throw new UserError(
            "O movimento precisa ter a mesma conta, data, moeda e valor.",
          );
        event = input.event_id;
      } else {
        const found = await candidates(tx, u.familyId, row);
        if (
          (found.events.length ||
            found.staged.length ||
            row.analysis?.group === "duplicate") &&
          !(input.distinct && input.note.length >= 12) &&
          !(
            input.staged_id &&
            row.analysis?.group !== "duplicate" &&
            found.staged.some((s) => s.id === input.staged_id) &&
            !found.events.length
          )
        )
          throw new UserError(
            "Há um possível registro anterior. Vincule-o ou selecione a evidência do extrato. Só registre outro se for distinto e justificar.",
          );
        if (!input.kind)
          throw new UserError("Informe a finalidade do movimento.");
        if (
          input.staged_id &&
          !found.staged.some((s) => s.id === input.staged_id)
        )
          throw new UserError(
            "A evidência do extrato não corresponde a este movimento.",
          );
        const localAccount = await accountFor(
          tx,
          u.familyId,
          row.local_account_id,
        );
        if (
          localAccount.kind === "card" &&
          ["income", "yield", "expense"].includes(input.kind)
        )
          throw new UserError(
            "No cartão, diferencie compra, pagamento e estorno. Crédito no cartão não é renda da família.",
          );
        const cardPaymentFromCard =
          localAccount.kind === "card" &&
          input.kind === "card_payment" &&
          BigInt(row.amount_cents) > 0n;
        if (cardPaymentFromCard && !input.counter_account_id)
          throw new UserError("Escolha a conta que pagou a fatura.");
        event = await createManualEventTx(tx, u, {
          account_id: cardPaymentFromCard
            ? input.counter_account_id!
            : row.local_account_id,
          date: row.transaction_date,
          description: row.description,
          amount: plainMoney(
            cardPaymentFromCard
              ? (-BigInt(row.amount_cents)).toString()
              : row.amount_cents,
          ),
          kind: input.kind,
          category_id: input.category_id,
          counter_account_id: cardPaymentFromCard
            ? row.local_account_id
            : input.counter_account_id,
          counter_currency: null,
          counter_amount: null,
          related_event_id: null,
          request_id: row.id,
        });
        if (input.staged_id) {
          await tx.query(
            "INSERT INTO event_sources(household_id,event_id,staged_id) VALUES($1,$2,$3)",
            [u.familyId, event, input.staged_id],
          );
          await tx.query(
            "UPDATE staged_transactions SET decision='link',link_event_id=$1,reviewed=true,review_note='Conferido com a leitura bancária',version=version+1 WHERE id=$2 AND household_id=$3",
            [event, input.staged_id, u.familyId],
          );
        }
      }
      // Reconnected items may reissue transaction IDs. The user must explicitly confirm
      // an already-consumed bank leg as a duplicate; never collapse repeated purchases silently.
      const previous = (
        await tx.query<{ id: string }>(
          "SELECT id FROM bank_transactions WHERE bank_account_id=$1 AND event_id=$2",
          [row.bank_account_id, event],
        )
      ).rows[0];
      if (previous) {
        if (
          input.decision !== "link" ||
          !input.duplicate ||
          input.note.length < 12
        )
          throw new UserError(
            "Esse lançamento já tem evidência bancária. Confirme expressamente a duplicidade e explique antes de vincular outra leitura.",
          );
        await tx.query(
          "UPDATE bank_transactions SET status='ignored',duplicate_of=$1,review_note=$2,version=version+1 WHERE id=$3",
          [previous.id, input.note, row.id],
        );
        await tx.query(
          "UPDATE bank_transactions SET missing=false,last_seen_run=(SELECT last_seen_run FROM bank_transactions WHERE id=$1) WHERE id=$2",
          [row.id, previous.id],
        );
        await recordAudit(tx, u.familyId, u.userId, "bank.duplicate", row.id, {
          original: previous.id,
        });
        return { ok: true };
      }
      await tx.query(
        "UPDATE bank_transactions SET status=$1,event_id=$2,review_note=$3,version=version+1 WHERE id=$4",
        [
          input.decision === "link" ? "linked" : "recorded",
          event,
          input.note,
          row.id,
        ],
      );
    }
    await recordAudit(tx, u.familyId, u.userId, "bank.review", row.id, {
      decision: input.decision,
    });
    return { ok: true };
  });
}
export async function syncOwnBanks(db: Database, u: Identity) {
  if (u.role === "reader" || !bankStorageReady())
    return { checked: 0, failed: 0 };
  const ids = await asUser(db, u.userId, (tx) =>
    tx.query<{ id: string }>(
      "SELECT id FROM bank_connections WHERE household_id=$1 AND user_id=$2 AND enabled AND (last_read_at IS NULL OR last_read_at<now()-interval '24 hours') AND (last_attempt_at IS NULL OR last_attempt_at<now()-interval '1 minute') ORDER BY last_attempt_at NULLS FIRST LIMIT 1",
      [u.familyId, u.userId],
    ),
  );
  let checked = 0,
    failed = 0;
  for (const row of ids.rows)
    try {
      const result = await syncBank(db, u, { id: row.id });
      if (!result.skipped) checked++;
    } catch {
      failed++;
    }
  return { checked, failed };
}
// Renewal changes the provider binding, never the app's account IDs or financial history.
export async function renewBank(
  db: Database,
  u: Identity,
  raw: unknown,
  factory: Factory = realReader,
) {
  writer(u);
  const input = z
    .object({
      id: z.uuid(),
      item_id: z.uuid(),
      confirm: z.boolean().default(false),
      mappings: z
        .array(
          z
            .object({ bank_account_id: z.uuid(), remote_account_id: z.uuid() })
            .strict(),
        )
        .max(50)
        .default([]),
    })
    .strict()
    .parse(raw);
  const previous = await asUser(db, u.userId, async (tx) => {
    const connection = (
      await tx.query<Connection>(
        "SELECT id,item_id,user_id,start_date::text,enabled FROM bank_connections WHERE id=$1 AND household_id=$2 AND user_id=$3",
        [input.id, u.familyId, u.userId],
      )
    ).rows[0];
    if (!connection)
      throw new UserError("Conexão indisponível para esse acesso.");
    const accounts = (
      await tx.query<{
        id: string;
        label: string;
        last_four: string;
        currency: string;
        account_type: string;
        local_account_id: string;
      }>(
        "SELECT id,label,last_four,currency,account_type,local_account_id FROM bank_accounts WHERE connection_id=$1 AND household_id=$2 AND active AND local_account_id IS NOT NULL",
        [input.id, u.familyId],
      )
    ).rows;
    return { connection, accounts };
  });
  const reader = factory(await credentials(db, u));
  await reader.authenticate();
  const item = await reader.item(input.item_id);
  usable(item);
  if (item.id !== input.item_id)
    throw new UserError("Autorização inconsistente.");
  const remote = await reader.accounts(item.id);
  if (!input.confirm)
    return {
      preview: true,
      previous: previous.accounts,
      remote: remote.map((a) => ({
        id: a.id,
        label: a.name,
        last_four: (a.number ?? "").replace(/[^0-9]/g, "").slice(-4),
        currency: a.currencyCode,
        account_type: a.type,
      })),
    };
  if (
    input.mappings.length !== previous.accounts.length ||
    new Set(input.mappings.map((m) => m.bank_account_id)).size !==
      input.mappings.length ||
    new Set(input.mappings.map((m) => m.remote_account_id)).size !==
      input.mappings.length
  )
    throw new UserError(
      "Associe cada conta anterior uma única vez à mesma conta na nova autorização.",
    );
  for (const old of previous.accounts) {
    const mapping = input.mappings.find((m) => m.bank_account_id === old.id),
      fresh = remote.find((a) => a.id === mapping?.remote_account_id);
    if (
      !fresh ||
      fresh.currencyCode !== old.currency ||
      fresh.type !== old.account_type
    )
      throw new UserError(
        "Confira as correspondências de conta, moeda e tipo.",
      );
  }
  return asUser(db, u.userId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "bank-map:" + u.familyId,
    ]);
    const held = (
      await tx.query<{ item_id: string }>(
        "SELECT item_id FROM bank_connections WHERE id=$1 AND household_id=$2 AND user_id=$3 FOR UPDATE",
        [input.id, u.familyId, u.userId],
      )
    ).rows[0];
    if (!held || held.item_id !== previous.connection.item_id)
      throw new UserError("A conexão mudou. Confira novamente.");
    const current = (
      await tx.query<{ id: string }>(
        "SELECT id FROM bank_accounts WHERE connection_id=$1 AND active AND local_account_id IS NOT NULL FOR UPDATE",
        [input.id],
      )
    ).rows;
    if (
      current.length !== previous.accounts.length ||
      current.some(
        (a) => !input.mappings.some((m) => m.bank_account_id === a.id),
      )
    )
      throw new UserError("Os vínculos mudaram. Confira novamente.");
    // Temporary independent UUIDs avoid collisions when provider IDs are reordered.
    const all = (
      await tx.query<{ id: string }>(
        "SELECT id FROM bank_accounts WHERE connection_id=$1",
        [input.id],
      )
    ).rows;
    for (const a of all)
      await tx.query(
        "UPDATE bank_accounts SET active=false,remote_id=$1 WHERE id=$2",
        [randomUUID(), a.id],
      );
    for (const m of input.mappings)
      await tx.query(
        "UPDATE bank_accounts SET active=true,remote_id=$1 WHERE id=$2 AND connection_id=$3",
        [m.remote_account_id, m.bank_account_id, input.id],
      );
    await tx.query(
      "UPDATE bank_connections SET item_id=$1,enabled=true,provider_status=$2,consent_expires_at=$3,provider_updated_at=$4,last_read_at=NULL,last_attempt_at=NULL,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$5",
      [
        item.id,
        item.status,
        item.consentExpiresAt ?? null,
        item.lastUpdatedAt ?? null,
        input.id,
      ],
    );
    await storeAccounts(tx, u, input.id, remote);
    await recordAudit(tx, u.familyId, u.userId, "bank.renew", input.id, {
      mapped: input.mappings.length,
      financial_events_changed: 0,
    });
    return { preview: false, previous: [], remote: [] };
  });
}
