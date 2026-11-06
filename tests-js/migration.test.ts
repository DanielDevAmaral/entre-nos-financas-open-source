import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { createFamily } from "../src/server/auth.ts";
import {
  captureFamily,
  migrateFamily,
  verifyFamily,
} from "../src/server/migration.ts";
test("migration preserves exact dates, microseconds, cents and credentials; failure rolls back and populated targets are refused", async () => {
  const source = await openDatabase(),
    target = await openDatabase();
  try {
    const uid = await createFamily(
      source,
      {
        name: "Teste migração",
        familyName: "Fictícia",
        email: "migration@example.invalid",
        password: "SenhaFicticiaMigracao!2026",
      },
      false,
    );
    const f = (
      await source.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [uid],
      )
    ).rows[0].household_id;
    const account = randomUUID(),
      event = randomUUID();
    await source.transaction(async (tx) => {
      await tx.exec("SET LOCAL TIME ZONE 'America/Sao_Paulo'");
      await tx.query(
        "UPDATE users SET created_at='2026-01-01 00:00:00.123456+00' WHERE id=$1",
        [uid],
      );
      await tx.query(
        "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by,opening_cents,opening_date) VALUES($1,$2,'Teste','Teste','BRL','checking',$3,'9007199254740993','2025-12-31')",
        [account, f, uid],
      );
      await tx.query(
        "INSERT INTO economic_events(id,household_id,account_id,kind,transaction_date,description,original_description,amount_cents,currency,created_by) VALUES($1,$2,$3,'expense','2026-01-01','Teste','Teste',-123,'BRL',$4)",
        [event, f, account, uid],
      );
      await tx.query(
        "INSERT INTO ledger_entries(id,household_id,event_id,account_id,nominal,currency,amount_cents,transaction_date) VALUES($1,$2,$3,$4,NULL,'BRL',-123,'2026-01-01'),($5,$2,$3,NULL,'expense','BRL',123,'2026-01-01')",
        [randomUUID(), f, event, account, randomUUID()],
      );
      await tx.query(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('fictitious',$1,'2027-01-01')",
        [uid],
      );
    });
    const snapshot = await captureFamily(source);
    const bad = structuredClone(snapshot);
    bad.tables.accounts.rows[0].name = "Adulterado";
    await assert.rejects(migrateFamily(target, bad), /divergente/);
    assert.equal((await target.query("SELECT 1 FROM users")).rows.length, 0);
    const counts = await migrateFamily(target, snapshot);
    assert.equal(counts.economic_events, 1);
    await verifyFamily(target, snapshot);
    const values = (
      await target.query<{ opening_date: string; opening_cents: string }>(
        "SELECT opening_date::text,opening_cents::text FROM accounts",
      )
    ).rows[0];
    assert.equal(values.opening_date, "2025-12-31");
    assert.equal(values.opening_cents, "9007199254740993");
    assert.equal(
      (
        await target.query<{ v: string }>(
          "SELECT (created_at AT TIME ZONE 'UTC')::text AS v FROM users",
        )
      ).rows[0].v,
      "2026-01-01 00:00:00.123456",
    );
    assert.equal((await target.query("SELECT 1 FROM sessions")).rows.length, 0);
    await assert.rejects(migrateFamily(target, snapshot), /vazio/);
    await verifyFamily(target, snapshot);
  } finally {
    await source.close();
    await target.close();
  }
});
