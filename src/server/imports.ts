import { deployment } from "./deployment.ts";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Transaction } from "@electric-sql/pglite";
import type { Database } from "./db.ts";
import { asUser, recordAudit } from "./db.ts";
import type { Identity } from "./auth.ts";
import {
  assertBalanced,
  dateOnly,
  normalize,
  postings,
  kinds,
  type AccountKind,
  type Currency,
  type Kind,
} from "../domain/finance.ts";

const integer = z
  .string()
  .regex(/^-?\d{1,16}$/)
  .refine(
    (n) =>
      BigInt(n) <= 9_000_000_000_000_000n &&
      BigInt(n) >= -9_000_000_000_000_000n,
  );
const currency = z.enum(["BRL", "USD", "EUR"]);
const rowSchema = z.object({
  date: z.string().transform(dateOnly),
  description: z.string().min(1).max(8000),
  original_description: z.string().min(1).max(12000),
  amount_cents: integer,
  currency,
  locator: z.string().max(200),
  bank_id: z.string().max(250).nullable().optional(),
  suggested_kind: z.enum(kinds),
  confidence: z.number().min(0).max(1),
  counter_currency: currency.optional(),
  counter_amount_cents: integer.optional(),
});
export const previewSchema = z.object({
  parser: z.string().max(80),
  currency,
  rows: z.array(rowSchema).max(5000),
  period_start: z.string().transform(dateOnly).optional(),
  period_end: z.string().transform(dateOnly).optional(),
  checks: z.array(z.object({ label: z.string(), passed: z.boolean() })),
  warnings: z.array(z.string()),
  reference: z.unknown().optional(),
  opening: z.object({ date: z.string(), cents: integer }).optional(),
  closing: z
    .object({ date: z.string().transform(dateOnly), cents: integer })
    .nullish(),
});
export type Preview = z.infer<typeof previewSchema>;
export type AccountRow = {
  id: string;
  household_id: string;
  currency: Currency;
  kind: AccountKind;
  opening_date: string | null;
  opening_cents: string | null;
  name: string;
};
export type StageRow = {
  id: string;
  batch_id: string;
  ordinal: number;
  transaction_date: string;
  processing_date: string | null;
  due_date: string | null;
  original_description: string;
  description: string;
  amount_cents: string;
  currency: Currency;
  bank_id: string | null;
  suggested_kind: Kind;
  kind: Kind | null;
  category_id: string | null;
  counter_account_id: string | null;
  counter_currency: Currency | null;
  counter_amount_cents: string | null;
  related_event_id: string | null;
  link_event_id: string | null;
  decision: "pending" | "accept" | "skip" | "link";
  reviewed: boolean;
  duplicate_hint: boolean;
  review_note: string;
  version: number;
  locator: string;
  confidence: number;
};
export const reviewSchema = z.object({
  id: z.uuid(),
  version: z.number().int().positive(),
  description: z.string().min(1).max(8000),
  kind: z.enum(kinds),
  category_id: z.uuid().nullable(),
  counter_account_id: z.uuid().nullable(),
  counter_currency: currency.nullable(),
  counter_amount_cents: integer.nullable(),
  related_event_id: z.uuid().nullable(),
  link_event_id: z.uuid().nullable(),
  decision: z.enum(["pending", "accept", "skip", "link"]),
  review_note: z.string().max(1000),
});
export type Review = z.infer<typeof reviewSchema>;
export class UserError extends Error {}
export async function extractPreview(
  file: File,
  selectedCurrency: Currency,
): Promise<Preview> {
  const ext = path.extname(file.name).toLowerCase();
  const hosted = deployment();
  if (hosted.remote) {
    if (
      ![".pdf", ".xlsx", ".csv"].includes(ext) ||
      !file.size ||
      file.size > 3 * 1024 * 1024
    )
      throw new UserError(
        "Use PDF, XLSX ou CSV com até 3 MB na versão hospedada.",
      );
    if (!process.env.PARSER_TOKEN || process.env.PARSER_TOKEN.length < 32)
      throw new UserError(
        "O serviço privado de importação ainda não foi configurado.",
      );
    const response = await fetch(hosted.origin + "/api/private_parser", {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.PARSER_TOKEN,
      },
      body: JSON.stringify({
        extension: ext,
        currency: selectedCurrency,
        data: Buffer.from(await file.arrayBuffer()).toString("base64"),
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok)
      throw new UserError(
        "Não foi possível extrair o arquivo no serviço privado. Nenhum lançamento foi confirmado.",
      );
    return previewSchema.parse(await response.json());
  }
  if (
    ![".pdf", ".xlsx", ".csv"].includes(ext) ||
    file.size > 10 * 1024 * 1024 ||
    file.size === 0
  )
    throw new UserError("Use PDF, XLSX ou CSV com até 10 MB.");
  const temp = path.resolve(
    process.env.FINANCE_DATA_DIR || "data",
    "import-temp",
  );
  await mkdir(temp, { recursive: true });
  const filename = path.join(temp, randomUUID() + ext);
  await writeFile(filename, Buffer.from(await file.arrayBuffer()), {
    flag: "wx",
  });
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        /* turbopackIgnore: true */ process.env.FINANCE_PYTHON || "python",
        ["-m", "tools.importar", filename, selectedCurrency],
        {
          cwd: process.cwd(),
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        },
      );
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new UserError(
            "Extração excedeu 60 segundos. Nenhum lançamento foi confirmado.",
          ),
        );
      }, 60000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > 20 * 1024 * 1024) {
          child.kill();
          reject(new UserError("Extração excedeu o limite de tamanho."));
        }
      });
      child.stderr.resume();
      child.on("error", () => {
        clearTimeout(timer);
        reject(
          new UserError(
            "Python não disponível. Configure FINANCE_PYTHON conforme o README.",
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else
          reject(
            new UserError(
              "Não foi possível extrair com segurança. Verifique o formato e as dependências Python.",
            ),
          );
      });
    });
    return previewSchema.parse(JSON.parse(text));
  } finally {
    await unlink(filename).catch(() => undefined);
  }
}
export async function accountFor(
  tx: Transaction,
  family: string,
  id: string,
): Promise<AccountRow> {
  const result = await tx.query<AccountRow>(
    "SELECT id,household_id,currency,kind,opening_date::text,opening_cents::text,name FROM accounts WHERE household_id=$1 AND id=$2",
    [family, id],
  );
  if (!result.rows[0])
    throw new UserError("Conta indisponível para esta família.");
  return result.rows[0];
}
export async function stagePreview(
  db: Database,
  user: Identity,
  accountId: string,
  file: { name: string; bytes: Buffer },
  preview: Preview,
): Promise<{ id: string; repeated: boolean }> {
  const parsed = previewSchema.parse(preview);
  const digest = createHash("sha256").update(file.bytes).digest("hex");
  return asUser(db, user.userId, async (tx) => {
    const account = await accountFor(tx, user.familyId, accountId);
    if (account.currency !== parsed.currency)
      throw new UserError(
        "A moeda do arquivo não corresponde à conta selecionada.",
      );
    const existing = await tx.query<{ id: string; account_id: string }>(
      "SELECT b.id,b.account_id FROM source_files s JOIN import_batches b ON b.source_id=s.id WHERE s.household_id=$1 AND s.sha256=$2",
      [user.familyId, digest],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].account_id !== accountId)
        throw new UserError(
          "Este arquivo já está associado a outra conta. Abra a prévia existente.",
        );
      return { id: existing.rows[0].id, repeated: true };
    }
    const sourceId = randomUUID(),
      batchId = randomUUID();
    await tx.query(
      "INSERT INTO source_files(id,household_id,sha256,filename,bytes,created_by) VALUES($1,$2,$3,$4,$5,$6)",
      [
        sourceId,
        user.familyId,
        digest,
        path.basename(file.name).slice(0, 250),
        file.bytes.length,
        user.userId,
      ],
    );
    await tx.query(
      "INSERT INTO import_batches(id,household_id,source_id,account_id,parser,checks,warnings,period_start,period_end,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        batchId,
        user.familyId,
        sourceId,
        accountId,
        parsed.parser,
        JSON.stringify(parsed.checks),
        JSON.stringify(parsed.warnings),
        parsed.period_start ?? null,
        parsed.period_end ?? null,
        user.userId,
      ],
    );
    await tx.query("UPDATE import_batches SET context=$1 WHERE id=$2", [
      JSON.stringify({
        opening: parsed.opening,
        closing: parsed.closing,
        reference: parsed.reference,
      }),
      batchId,
    ]);
    const seen = new Set<string>();
    for (const [index, row] of parsed.rows.entries()) {
      if (row.currency !== account.currency)
        throw new UserError(
          "Há uma linha com moeda diferente da conta selecionada.",
        );
      const key = [
        row.date,
        row.currency,
        row.amount_cents,
        normalize(row.original_description),
      ].join("|");
      const bankCollision = row.bank_id
        ? await tx.query(
            "SELECT 1 FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id WHERE s.household_id=$1 AND b.account_id=$2 AND s.bank_id=$3 LIMIT 1",
            [user.familyId, accountId, row.bank_id],
          )
        : { rows: [] };
      const overlap = await tx.query(
        "SELECT 1 FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id WHERE s.household_id=$1 AND b.account_id=$2 AND s.transaction_date=$3 AND s.amount_cents=$4 AND (s.fingerprint=$5 OR (s.fingerprint IS NULL AND upper(s.original_description)=upper($6))) LIMIT 1",
        [
          user.familyId,
          accountId,
          row.date,
          row.amount_cents,
          key,
          row.original_description,
        ],
      );
      const collision =
        seen.has(key) ||
        bankCollision.rows.length > 0 ||
        overlap.rows.length > 0;
      seen.add(key);
      await tx.query(
        "INSERT INTO staged_transactions(id,household_id,batch_id,ordinal,locator,transaction_date,original_description,description,amount_cents,currency,bank_id,suggested_kind,confidence,kind,duplicate_hint,counter_currency,counter_amount_cents,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$12,$14,$15,$16,$17)",
        [
          randomUUID(),
          user.familyId,
          batchId,
          index + 1,
          row.locator,
          row.date,
          row.original_description,
          row.description,
          row.amount_cents,
          row.currency,
          row.bank_id ?? null,
          row.suggested_kind,
          row.confidence,
          collision,
          row.counter_currency ?? null,
          row.counter_amount_cents ?? null,
          key,
        ],
      );
      const normalized = normalize(row.description);
      const mapping: [RegExp, string][] = [
        [/SUPERMERC|HORTIFRUT|ACOUGUE|IFOOD|MERCADO/, "Alimentação"],
        [/UBER|COMBUST|GASOLINA/, "Transporte"],
        [/FARMAC|DROGARIA|HOSPITAL/, "Saúde"],
        [/ENERGIA|INTERNET|ALUGUEL|SANEAMENTO/, "Moradia"],
        [/TARIFA|IOF|TAXA/, "Impostos e tarifas"],
        [/SALARIO|REMUNERACAO/, "Receitas profissionais"],
      ];
      const category = mapping.find(([pattern]) =>
        pattern.test(normalized),
      )?.[1];
      if (category)
        await tx.query(
          "UPDATE staged_transactions SET category_id=(SELECT id FROM categories WHERE household_id=$1 AND name=$2) WHERE batch_id=$3 AND ordinal=$4",
          [user.familyId, category, batchId, index + 1],
        );
    }
    await recordAudit(
      tx,
      user.familyId,
      user.userId,
      "import.preview",
      batchId,
      { rows: parsed.rows.length, parser: parsed.parser },
    );
    return { id: batchId, repeated: false };
  });
}
export async function saveReview(
  db: Database,
  user: Identity,
  batchId: string,
  rows: Review[],
) {
  return asUser(db, user.userId, async (tx) => {
    const batch = await tx.query<{ status: string }>(
      "SELECT status FROM import_batches WHERE id=$1 AND household_id=$2 FOR UPDATE",
      [batchId, user.familyId],
    );
    if (batch.rows[0]?.status !== "preview")
      throw new UserError("Prévia não disponível para edição.");
    for (const raw of rows) {
      const row = reviewSchema.parse(raw);
      if (
        (
          await tx.query(
            "SELECT 1 FROM event_sources WHERE staged_id=$1 AND household_id=$2",
            [row.id, user.familyId],
          )
        ).rows.length
      )
        throw new UserError(
          "Este item já foi registrado. O histórico confirmado não pode ser sobrescrito.",
        );
      if (row.decision === "skip" && !row.review_note.trim())
        throw new UserError("Informe o motivo para ignorar um lançamento.");
      const previous = (
        await tx.query(
          "SELECT kind,category_id,counter_account_id,decision,version FROM staged_transactions WHERE id=$1 AND batch_id=$2 AND household_id=$3",
          [row.id, batchId, user.familyId],
        )
      ).rows[0];
      const changed = await tx.query(
        "UPDATE staged_transactions SET description=$1,kind=$2,category_id=$3,counter_account_id=$4,counter_currency=$5,counter_amount_cents=$6,related_event_id=$7,link_event_id=$8,decision=$9,review_note=$10,reviewed=true,version=version+1 WHERE id=$11 AND batch_id=$12 AND household_id=$13 AND version=$14 RETURNING id",
        [
          row.description,
          row.kind,
          row.category_id,
          row.counter_account_id,
          row.counter_currency,
          row.counter_amount_cents,
          row.related_event_id,
          row.link_event_id,
          row.decision,
          row.review_note,
          row.id,
          batchId,
          user.familyId,
          row.version,
        ],
      );
      if (!changed.rows.length)
        throw new UserError(
          "A revisão foi alterada em outra sessão. Reabra a prévia.",
        );
      await recordAudit(
        tx,
        user.familyId,
        user.userId,
        "import.item.review",
        row.id,
        {
          before: previous,
          after: {
            kind: row.kind,
            category_id: row.category_id,
            counter_account_id: row.counter_account_id,
            decision: row.decision,
            version: row.version + 1,
          },
        },
      );
    }
    await recordAudit(
      tx,
      user.familyId,
      user.userId,
      "import.review",
      batchId,
      { rows: rows.length },
    );
  });
}
export async function remapPreview(
  db: Database,
  user: Identity,
  batchId: string,
  accountId: string,
) {
  return asUser(db, user.userId, async (tx) => {
    if (
      (
        await tx.query(
          "SELECT 1 FROM event_sources es JOIN staged_transactions s ON s.id=es.staged_id WHERE s.batch_id=$1 AND s.household_id=$2 LIMIT 1",
          [batchId, user.familyId],
        )
      ).rows.length
    )
      throw new UserError(
        "Esta prévia já possui itens registrados. Sua conta não pode ser alterada.",
      );
    const batch = (
      await tx.query<{ status: string; account_id: string }>(
        "SELECT status,account_id FROM import_batches WHERE id=$1 AND household_id=$2 FOR UPDATE",
        [batchId, user.familyId],
      )
    ).rows[0];
    if (!batch || batch.status !== "preview")
      throw new UserError(
        "Somente prévias ainda não confirmadas podem trocar de conta.",
      );
    if (batch.account_id === accountId) return;
    const before = await accountFor(tx, user.familyId, batch.account_id),
      target = await accountFor(tx, user.familyId, accountId);
    if (before.currency !== target.currency)
      throw new UserError("A nova conta precisa ter a mesma moeda do arquivo.");
    const rows = (
      await tx.query<StageRow & { fingerprint: string }>(
        "SELECT *,transaction_date::text,amount_cents::text FROM staged_transactions WHERE batch_id=$1 ORDER BY ordinal",
        [batchId],
      )
    ).rows;
    const seenKeys = new Set<string>(),
      seenIds = new Set<string>();
    for (const row of rows) {
      const key =
        row.fingerprint ||
        [
          row.transaction_date,
          row.currency,
          row.amount_cents,
          normalize(row.original_description),
        ].join("|");
      const match = await tx.query(
        "SELECT 1 FROM staged_transactions s JOIN import_batches b ON b.id=s.batch_id WHERE s.household_id=$1 AND b.account_id=$2 AND s.batch_id<>$3 AND ((s.bank_id=$4 AND $4 IS NOT NULL) OR (s.transaction_date=$5 AND s.amount_cents=$6 AND (s.fingerprint=$7 OR upper(s.original_description)=upper($8)))) LIMIT 1",
        [
          user.familyId,
          accountId,
          batchId,
          row.bank_id,
          row.transaction_date,
          row.amount_cents,
          key,
          row.original_description,
        ],
      );
      const duplicate =
        match.rows.length > 0 ||
        seenKeys.has(key) ||
        !!(row.bank_id && seenIds.has(row.bank_id));
      await tx.query(
        "UPDATE staged_transactions SET decision='pending',reviewed=false,duplicate_hint=$1,counter_account_id=NULL,related_event_id=NULL,link_event_id=NULL,version=version+1 WHERE id=$2",
        [duplicate, row.id],
      );
      seenKeys.add(key);
      if (row.bank_id) seenIds.add(row.bank_id);
    }
    await tx.query("UPDATE import_batches SET account_id=$1 WHERE id=$2", [
      accountId,
      batchId,
    ]);
    await recordAudit(tx, user.familyId, user.userId, "import.remap", batchId, {
      before: before.id,
      after: target.id,
      rows: rows.length,
    });
  });
}
export async function addEvent(
  tx: Transaction,
  user: Identity,
  account: AccountRow,
  row: StageRow,
): Promise<string> {
  if (!row.kind) throw new UserError("Escolha o tipo financeiro.");
  if (row.kind === "fx" && row.bank_id?.startsWith("BALANCE-")) {
    const reciprocal = await tx.query(
      "SELECT 1 FROM event_sources es JOIN staged_transactions s ON s.id=es.staged_id JOIN economic_events e ON e.id=es.event_id WHERE s.household_id=$1 AND s.bank_id=$2 AND s.currency<>$3 AND e.kind='fx' LIMIT 1",
      [user.familyId, row.bank_id, row.currency],
    );
    if (reciprocal.rows.length)
      throw new UserError(
        "A outra perna deste câmbio já foi confirmada. Vincule esta evidência ao evento existente para não duplicar a conversão.",
      );
  }
  if (row.currency !== account.currency)
    throw new UserError("A moeda do movimento não corresponde à conta.");
  let category = row.category_id;
  if (
    ["expense", "card_purchase", "fee", "income", "yield"].includes(row.kind) &&
    !category
  )
    throw new UserError(`Selecione uma categoria no item ${row.ordinal}.`);
  if (row.duplicate_hint && !row.review_note.trim())
    throw new UserError("Possível duplicidade exige justificativa de revisão.");
  const paired = [
    "transfer",
    "card_payment",
    "investment_buy",
    "investment_sell",
    "fx",
  ].includes(row.kind);
  const counter =
    paired && row.counter_account_id
      ? await accountFor(tx, user.familyId, row.counter_account_id)
      : null;
  if (paired) category = null;
  if (counter && row.kind !== "fx" && counter.currency !== row.currency)
    throw new UserError(
      "Transferência entre moedas distintas exige o tipo câmbio.",
    );
  if (row.kind === "fx" && counter?.currency !== row.counter_currency)
    throw new UserError(
      "A moeda de contrapartida não corresponde à conta escolhida.",
    );
  if (row.kind === "refund") {
    const original = await tx.query<{
      amount_cents: string;
      currency: string;
      category_id: string;
      kind: string;
    }>(
      "SELECT amount_cents::text,currency,category_id,kind FROM economic_events WHERE household_id=$1 AND id=$2",
      [user.familyId, row.related_event_id],
    );
    const event = original.rows[0];
    if (
      !event ||
      !["expense", "card_purchase", "fee"].includes(event.kind) ||
      event.currency !== row.currency
    )
      throw new UserError("Vincule o reembolso a uma despesa da mesma moeda.");
    const refunded = await tx.query<{ total: string }>(
      "SELECT coalesce(sum(amount_cents),0)::text AS total FROM economic_events WHERE related_event_id=$1 AND kind='refund'",
      [row.related_event_id],
    );
    if (
      BigInt(refunded.rows[0].total) + BigInt(row.amount_cents) >
      -BigInt(event.amount_cents)
    )
      throw new UserError("Reembolso supera a despesa original.");
    category = event.category_id;
  }
  const entries = postings({
    kind: row.kind,
    amount: BigInt(row.amount_cents),
    accountId: account.id,
    currency: row.currency,
    accountKind: account.kind,
    counterId: counter?.id,
    counterKind: counter?.kind,
    counterCurrency: row.counter_currency ?? undefined,
    counterAmount: row.counter_amount_cents
      ? BigInt(row.counter_amount_cents)
      : undefined,
  });
  assertBalanced(entries);
  for (const acct of [account, counter].filter(
    (v): v is AccountRow => v !== null,
  )) {
    if (acct.opening_date && row.transaction_date <= acct.opening_date)
      throw new UserError(
        `O item ${row.ordinal} está incluído ou é anterior à abertura de uma conta. Revise a data de abertura.`,
      );
  }
  const id = randomUUID();
  await tx.query(
    "INSERT INTO economic_events(id,household_id,account_id,counter_account_id,kind,transaction_date,processing_date,due_date,description,original_description,amount_cents,currency,category_id,related_event_id,created_by,counter_currency,counter_amount_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)",
    [
      id,
      user.familyId,
      account.id,
      counter?.id ?? null,
      row.kind,
      row.transaction_date,
      row.processing_date,
      row.due_date,
      row.description,
      row.original_description,
      row.amount_cents,
      row.currency,
      category,
      row.kind === "refund" ? row.related_event_id : null,
      user.userId,
      row.kind === "fx" ? row.counter_currency : null,
      row.kind === "fx" ? row.counter_amount_cents : null,
    ],
  );
  for (const entry of entries)
    await tx.query(
      "INSERT INTO ledger_entries(id,household_id,event_id,account_id,nominal,currency,amount_cents,transaction_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        randomUUID(),
        user.familyId,
        id,
        entry.accountId,
        entry.nominal,
        entry.currency,
        entry.cents.toString(),
        row.transaction_date,
      ],
    );
  return id;
}
export async function confirmBatch(
  db: Database,
  user: Identity,
  batchId: string,
) {
  return asUser(db, user.userId, async (tx) => {
    const batchResult = await tx.query<{
      id: string;
      status: string;
      account_id: string;
      checks: { label: string; passed: boolean }[];
    }>(
      "SELECT id,status,account_id,checks FROM import_batches WHERE id=$1 AND household_id=$2 FOR UPDATE",
      [batchId, user.familyId],
    );
    const batch = batchResult.rows[0];
    if (!batch) throw new UserError("Importação indisponível.");
    if (batch.status === "confirmed")
      return { alreadyConfirmed: true, created: 0, linked: 0, skipped: 0 };
    if (!batch.checks.length || batch.checks.some((c) => !c.passed))
      throw new UserError(
        "Há falha de extração ou conciliação. O lote não pode ser confirmado.",
      );
    const rows = (
      await tx.query<StageRow>(
        "SELECT *,transaction_date::text,processing_date::text,due_date::text,amount_cents::text,counter_amount_cents::text FROM staged_transactions WHERE batch_id=$1 AND household_id=$2 ORDER BY ordinal",
        [batchId, user.familyId],
      )
    ).rows;
    if (
      !rows.length ||
      rows.some((r) => !r.reviewed || r.decision === "pending")
    )
      throw new UserError("Revise todos os itens antes de confirmar.");
    const account = await accountFor(tx, user.familyId, batch.account_id);
    let created = 0,
      linked = 0,
      skipped = 0;
    for (const row of rows) {
      if (row.decision === "skip") {
        skipped++;
        continue;
      }
      if (
        (
          await tx.query(
            "SELECT 1 FROM event_sources WHERE staged_id=$1 AND household_id=$2",
            [row.id, user.familyId],
          )
        ).rows.length
      )
        continue;
      let eventId: string;
      if (row.decision === "link") {
        if (
          account.opening_date &&
          row.transaction_date <= account.opening_date
        )
          throw new UserError(
            "A origem vinculada está incluída ou é anterior à abertura da conta. Revise a abertura antes de vincular.",
          );
        if (!row.link_event_id || !row.review_note.trim())
          throw new UserError(
            "Vínculo exige evento existente e justificativa.",
          );
        const match = await tx.query(
          "SELECT e.id FROM economic_events e JOIN ledger_entries l ON l.event_id=e.id WHERE e.household_id=$1 AND e.id=$2 AND e.kind IN ('transfer','card_payment','investment_buy','investment_sell','fx') AND l.account_id=$3 AND l.currency=$4 AND l.amount_cents=$5 AND abs(e.transaction_date-$6::date)<=3 AND NOT EXISTS(SELECT 1 FROM event_sources es JOIN staged_transactions s ON s.id=es.staged_id JOIN import_batches b ON b.id=s.batch_id WHERE es.event_id=e.id AND b.account_id=$3)",
          [
            user.familyId,
            row.link_event_id,
            account.id,
            row.currency,
            row.amount_cents,
            row.transaction_date,
          ],
        );
        if (!match.rows.length)
          throw new UserError(
            "O evento não corresponde à conta, moeda, data e valor, ou essa perna já tem origem vinculada.",
          );
        eventId = row.link_event_id;
        await tx.query(
          "UPDATE ledger_entries SET transaction_date=$1 WHERE event_id=$2 AND account_id=$3",
          [row.transaction_date, eventId, account.id],
        );
        linked++;
      } else {
        eventId = await addEvent(tx, user, account, row);
        created++;
      }
      await tx.query(
        "INSERT INTO event_sources(household_id,event_id,staged_id) VALUES($1,$2,$3)",
        [user.familyId, eventId, row.id],
      );
    }
    await tx.query(
      "UPDATE import_batches SET status='confirmed',confirmed_at=now() WHERE id=$1",
      [batchId],
    );
    await refreshReconciliations(tx, user.familyId);
    await recordAudit(
      tx,
      user.familyId,
      user.userId,
      "import.confirm",
      batchId,
      { created, linked, skipped },
    );
    return { alreadyConfirmed: false, created, linked, skipped };
  });
}
export async function refreshReconciliations(tx: Transaction, family: string) {
  const batches = (
    await tx.query<{
      id: string;
      account_id: string;
      context: Record<string, unknown> & {
        closing?: { date: string; cents: string };
      };
    }>(
      "SELECT id,account_id,context FROM import_batches WHERE household_id=$1 AND status='confirmed' AND context->'closing' IS NOT NULL",
      [family],
    )
  ).rows;
  for (const batch of batches) {
    const checkpoint = batch.context.closing;
    if (!checkpoint) continue;
    const account = await accountFor(tx, family, batch.account_id);
    let reconciliation: Record<string, unknown>;
    if (
      account.opening_cents === null ||
      !account.opening_date ||
      account.opening_date > checkpoint.date
    ) {
      reconciliation = {
        status: "unavailable",
        date: checkpoint.date,
        reason: "Abertura ausente ou posterior ao saldo observado.",
      };
    } else {
      const total = (
        await tx.query<{ total: string }>(
          "SELECT coalesce(sum(amount_cents),0)::text AS total FROM ledger_entries WHERE household_id=$1 AND account_id=$2 AND transaction_date>$3 AND transaction_date<=$4",
          [family, account.id, account.opening_date, checkpoint.date],
        )
      ).rows[0].total;
      const book = BigInt(account.opening_cents) + BigInt(total),
        difference = book - BigInt(checkpoint.cents);
      reconciliation = {
        status: difference === 0n ? "balanced" : "difference",
        date: checkpoint.date,
        book_cents: book.toString(),
        statement_cents: checkpoint.cents,
        difference_cents: difference.toString(),
      };
    }
    await tx.query("UPDATE import_batches SET context=$1 WHERE id=$2", [
      JSON.stringify({ ...batch.context, reconciliation }),
      batch.id,
    ]);
  }
}
