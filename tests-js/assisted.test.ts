import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import {
  applyPlanning,
  prefillAndRecord,
  categoryFor,
} from "../src/server/assisted.ts";
import {
  stagePreview,
  saveReview,
  remapPreview,
  confirmBatch,
} from "../src/server/imports.ts";
import { readState } from "../src/server/state.ts";

test("planning import is idempotent; actual references do not become expenses; bad planned categories stay unavailable", async () => {
  const db = await openDatabase();
  try {
    const uid = await createFamily(
      db,
      {
        name: "Pessoa Fictícia",
        familyName: "Teste",
        email: "assist@example.invalid",
        password: "senha-ficticia-longa",
      },
      false,
    );
    const family = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [uid],
      )
    ).rows[0].household_id;
    const u: Identity = {
      userId: uid,
      familyId: family,
      name: "Pessoa Fictícia",
      email: "assist@example.invalid",
      role: "owner",
    };
    const line = {
      month: "2026-10-01",
      sheet: "Outubro",
      cell: "B3",
      label: "Supermercado",
      planned_cents: "80000",
      actual_cents: "75000",
      purpose: "expense",
      derived: true,
      notes: "PAGO",
      error: null,
      actual_error: null,
      formula: null,
    };
    const raw = {
      entries: [
        line,
        {
          ...line,
          cell: "B4",
          label: "Celulares",
          planned_cents: null,
          error: "Referência quebrada",
        },
        {
          ...line,
          cell: "B5",
          label: "Cartões",
          purpose: "card",
          planned_cents: "13900",
        },
      ],
    };
    assert.equal(
      (await applyPlanning(db, u, raw, "hash-demo", "ficticio.xlsx")).budgets,
      1,
    );
    assert.equal(
      (await applyPlanning(db, u, raw, "hash-demo", "renomeado.xlsx"))
        .alreadyImported,
      true,
    );
    assert.equal(
      (await db.query("SELECT * FROM economic_events")).rows.length,
      0,
    );
    assert.equal(
      (await db.query("SELECT * FROM planning_lines")).rows.length,
      3,
    );
    const bank = randomUUID();
    await asUser(db, uid, (tx) =>
      tx.query(
        "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Banco','Fictício','BRL','checking',$3)",
        [bank, family, uid],
      ),
    );
    const staged = await stagePreview(
      db,
      u,
      bank,
      { name: "ficticio.csv", bytes: Buffer.from("fixture") },
      {
        parser: "ficticio",
        currency: "BRL",
        checks: [{ label: "OK", passed: true }],
        warnings: [],
        rows: [
          {
            date: "2026-10-02",
            description: "Compra no débito SUPERMERCADO fictício",
            original_description: "Compra no débito SUPERMERCADO fictício",
            amount_cents: "-5000",
            currency: "BRL",
            locator: "linha 2",
            suggested_kind: "expense",
            confidence: 0.8,
          },
          {
            date: "2026-10-03",
            description: "Transferência recebida pelo Pix desconhecido",
            original_description:
              "Transferência recebida pelo Pix desconhecido",
            amount_cents: "10000",
            currency: "BRL",
            locator: "linha 3",
            suggested_kind: "income",
            confidence: 0.25,
          },
        ],
      },
    );
    const done = await prefillAndRecord(db, u, true);
    assert.equal(done.created, 1);
    assert.equal(done.remaining, 1);
    assert.equal((await prefillAndRecord(db, u, true)).created, 0);
    const state = await readState(db, u, "2026-10-01", "BRL");
    assert.equal(state.summary.expense_cents, "5000");
    assert.equal(state.pending.counts.rows, 1);
    assert.equal(state.budgets[0].spent_cents, "5000");
    const saved = (
      await db.query<{ id: string }>(
        "SELECT staged_id AS id FROM event_sources",
      )
    ).rows[0].id;
    await assert.rejects(
      saveReview(db, u, staged.id, [
        {
          id: saved,
          version: 2,
          description: "alterar",
          kind: "expense",
          category_id: null,
          counter_account_id: null,
          counter_currency: null,
          counter_amount_cents: null,
          related_event_id: null,
          link_event_id: null,
          decision: "skip",
          review_note: "teste",
        },
      ]),
      /já foi registrado/,
    );
    await assert.rejects(
      remapPreview(db, u, staged.id, bank),
      /já possui itens/,
    );
    await assert.rejects(confirmBatch(db, u, staged.id), /Revise todos/);
    assert.equal(
      (await db.query("SELECT * FROM economic_events")).rows.length,
      1,
    );
  } finally {
    await db.close();
  }
});
test("categorization recognizes supplied labels without guessing unknown Pix", () => {
  assert.equal(categoryFor("Contador").name, "Atividade profissional");
  assert.equal(
    categoryFor("Transferência enviada pelo Pix pessoa desconhecida").strong,
    false,
  );
  assert.equal(
    categoryFor("Wise Charges for: BALANCE-ficticio").name,
    "Impostos e tarifas",
  );
});
