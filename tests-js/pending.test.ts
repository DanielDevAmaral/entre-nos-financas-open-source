import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  analyzePending,
  fxEvidence,
  pendingRows,
  repairPendingFx,
  type PendingRow,
} from "../src/server/pending.ts";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { stagePreview, confirmBatch } from "../src/server/imports.ts";
import { readState } from "../src/server/state.ts";

function row(fields: Partial<PendingRow> = {}): PendingRow {
  return {
    id: randomUUID(),
    batch_id: randomUUID(),
    account_id: "brl",
    account_name: "Banco fictício",
    filename: "ficticio.pdf",
    ordinal: 1,
    locator: "página 1",
    transaction_date: "2026-01-10",
    amount_cents: "50000",
    currency: "BRL",
    bank_id: "BALANCE-demo",
    description: "100,00 USD convertidos para 500,00 BRL",
    original_description: "100,00 USD convertidos para 500,00 BRL",
    kind: "fx",
    counter_account_id: null,
    counter_currency: "USD",
    counter_amount_cents: "-10000",
    decision: "pending",
    reviewed: false,
    version: 1,
    review_note: "",
    ...fields,
  };
}
function conversion() {
  return [
    row(),
    row({
      account_id: "usd",
      currency: "USD",
      amount_cents: "-9900",
      counter_currency: "BRL",
      counter_amount_cents: "50000",
    }),
    row({
      account_id: "usd",
      currency: "USD",
      amount_cents: "-100",
      counter_currency: null,
      counter_amount_cents: null,
      bank_id: "FEE-BALANCE-demo",
      kind: "expense",
      description: "Wise Charges for: BALANCE-demo",
      original_description: "Wise Charges for: BALANCE-demo",
    }),
  ];
}
test("own transfers require full holder evidence, or holder plus reciprocal bank provider; a shared first name is insufficient", () => {
  const debit = row({
    account_id: "wise-brl",
    account_name: "Wise BRL",
    bank_id: "TRANSFER-unique",
    kind: "expense",
    amount_cents: "-50000",
    currency: "BRL",
    description: "Enviou dinheiro para PESSOA TESTE",
    original_description: "Enviou dinheiro para PESSOA TESTE",
  });
  const credit = row({
    account_id: "nubank",
    account_name: "Nubank",
    bank_id: "PIX-unique",
    kind: "income",
    amount_cents: "50000",
    currency: "BRL",
    description: "Transferência recebida WISE BRASIL",
    original_description: "Transferência recebida WISE BRASIL",
  });
  assert.equal(
    analyzePending([debit, credit], "Pessoa Teste").counts.transfers,
    1,
  );
  const someoneElse = {
    ...debit,
    description: "Enviou dinheiro para PESSOA OUTRA",
  };
  assert.equal(
    analyzePending([someoneElse, credit], "Pessoa Teste").counts.transfers,
    0,
  );
  assert.equal(
    analyzePending(
      [debit, { ...credit, description: "Transferência recebida de terceiro" }],
      "Pessoa Teste",
    ).counts.transfers,
    0,
  );
});

test("FX requires reciprocal evidence and preserves separate fee", () => {
  const rs = conversion();
  const result = fxEvidence(rs);
  assert.equal(result[0].safe, true);
  const a = analyzePending(rs);
  assert.equal(a.counts.fx, 1);
  assert.equal(a.counts.fees, 1);
  assert.equal(a.totals[0].cents, "100");
  assert.equal(
    a.findings.find((f) => f.group === "Câmbio")!.strength,
    "Ajuste seguro disponível",
  );
});
test("ambiguous fees, reused IDs, dates and value differences block auto correction", () => {
  for (const mutate of [
    (rs: PendingRow[]) => rs.push({ ...rs[2], id: randomUUID() }),
    (rs: PendingRow[]) => rs.push({ ...rs[0], id: randomUUID() }),
    (rs: PendingRow[]) => {
      rs[2].amount_cents = "-101";
    },
    (rs: PendingRow[]) => {
      rs[1].transaction_date = "2026-01-11";
    },
    (rs: PendingRow[]) => {
      rs[2].account_id = "unrelated";
    },
  ]) {
    const rs = conversion();
    mutate(rs);
    assert.equal(fxEvidence(rs)[0].safe, false);
  }
});
test("same value at a merchant and investment redemption is not a transfer", () => {
  const rs = [
    row({
      amount_cents: "-4000",
      kind: "expense",
      bank_id: null,
      description: "Posto fictício",
      original_description: "Posto fictício",
    }),
    row({
      account_id: "other",
      amount_cents: "4000",
      kind: "investment_sell",
      bank_id: null,
      description: "Resgate RDB",
      original_description: "Resgate RDB",
    }),
  ];
  assert.equal(analyzePending(rs, "Pessoa fictícia").counts.transfers, 0);
});
test("ID reuse for debit and refund stays a review finding", () => {
  const rs = [
    row({
      bank_id: "CARD-demo",
      kind: "expense",
      amount_cents: "-497",
      description: "Cartão",
      original_description: "Cartão",
    }),
    row({
      bank_id: "CARD-demo",
      kind: "expense",
      amount_cents: "497",
      description: "Cartão",
      original_description: "Cartão",
    }),
  ];
  assert.equal(analyzePending(rs).counts.duplicates, 1);
});

test("preparation is audited, idempotent, tenant isolated and does not approve or alter bank amounts", async () => {
  const db = await openDatabase();
  try {
    const userId = await createFamily(
      db,
      {
        name: "Pessoa fictícia",
        familyName: "Teste",
        email: "fx@example.invalid",
        password: "senha-ficticia-longa",
      },
      false,
    );
    const family = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [userId],
      )
    ).rows[0].household_id;
    const user: Identity = {
      userId,
      familyId: family,
      name: "Pessoa fictícia",
      email: "fx@example.invalid",
      role: "owner",
    };
    const accounts = { BRL: randomUUID(), USD: randomUUID() };
    for (const [currency, id] of Object.entries(accounts))
      await asUser(db, userId, (tx) =>
        tx.query(
          "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,$3,'Fictícia',$3,'checking',$4)",
          [id, family, currency, userId],
        ),
      );
    const rs = conversion();
    for (const currency of ["BRL", "USD"] as const) {
      await stagePreview(
        db,
        user,
        accounts[currency],
        { name: currency + ".pdf", bytes: Buffer.from(currency) },
        {
          parser: "ficticio",
          currency,
          checks: [{ label: "Fictício", passed: true }],
          warnings: [],
          rows: rs
            .filter((r) => r.currency === currency)
            .map((r) => ({
              date: r.transaction_date,
              amount_cents: r.amount_cents,
              currency: r.currency,
              description: r.description,
              original_description: r.original_description,
              locator: r.locator,
              bank_id: r.bank_id,
              suggested_kind: r.kind as "fx" | "expense",
              confidence: 0.95,
              ...(r.counter_currency
                ? {
                    counter_currency: r.counter_currency,
                    counter_amount_cents: r.counter_amount_cents!,
                  }
                : {}),
            })),
        },
      );
    }
    const before = await asUser(db, userId, (tx) => pendingRows(tx, family));
    assert.equal((await repairPendingFx(db, user)).changed, 3);
    const after = await asUser(db, userId, (tx) => pendingRows(tx, family));
    for (const r of after) {
      const old = before.find((o) => o.id === r.id)!;
      assert.equal(r.amount_cents, old.amount_cents);
      assert.equal(r.original_description, old.original_description);
      assert.equal(r.reviewed, false);
      assert.equal(r.decision, "pending");
      assert.equal(r.version, old.version + 1);
    }
    const usd = after.find((r) => r.currency === "USD" && r.kind === "fx")!;
    const brl = after.find((r) => r.currency === "BRL")!;
    const state = await readState(db, user, "2026-01-01", "BRL");
    assert.ok(state.insights.some((i) => i.type === "pending_fx"));
    assert.equal(brl.counter_amount_cents, "-9900");
    assert.equal(brl.counter_account_id, accounts.USD);
    assert.equal(usd.counter_account_id, accounts.BRL);
    assert.equal((await repairPendingFx(db, user)).changed, 0);
    assert.equal(
      (await db.query("SELECT * FROM economic_events")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM ledger_entries")).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM audit_events WHERE action IN ('import.fx.prepare','import.fee.prepare')",
        )
      ).rows.length,
      3,
    );
    await asUser(db, userId, (tx) =>
      tx.query(
        "UPDATE staged_transactions SET reviewed=true,counter_amount_cents='-10000' WHERE id=$1",
        [brl.id],
      ),
    );
    assert.equal((await repairPendingFx(db, user)).changed, 0);
    const outsider = await createFamily(
      db,
      {
        name: "Outra pessoa",
        familyName: "Outra",
        email: "otherfx@example.invalid",
        password: "senha-ficticia-longa",
      },
      false,
    );
    const otherfamily = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [outsider],
      )
    ).rows[0].household_id;
    assert.equal(
      (
        await repairPendingFx(db, {
          ...user,
          userId: outsider,
          familyId: otherfamily,
        })
      ).changed,
      0,
    );
    await asUser(db, userId, (tx) =>
      tx.query(
        "UPDATE staged_transactions SET reviewed=true,decision='accept',counter_amount_cents='-9900' WHERE id=$1",
        [brl.id],
      ),
    );
    await confirmBatch(db, user, brl.batch_id);
    await asUser(db, userId, (tx) =>
      tx.query(
        "UPDATE staged_transactions SET reviewed=true,decision='accept' WHERE batch_id=$1",
        [usd.batch_id],
      ),
    );
    await assert.rejects(confirmBatch(db, user, usd.batch_id), /outra perna/);
    assert.equal(
      (await db.query("SELECT * FROM economic_events WHERE kind='fx'")).rows
        .length,
      1,
    );
  } finally {
    await db.close();
  }
});
