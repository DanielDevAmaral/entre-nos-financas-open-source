import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { stagePreview } from "../src/server/imports.ts";
import { prepareOpenings } from "../src/server/assisted.ts";
import { readState } from "../src/server/state.ts";
test("all imported rows stay visible before classification; proven openings are idempotent and never create events", async () => {
  const db = await openDatabase();
  try {
    const uid = await createFamily(
      db,
      {
        name: "Pessoa Teste",
        email: "mobile@example.invalid",
        password: "senha-ficticia-longa",
        familyName: "Teste",
      },
      false,
    );
    const family = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [uid],
      )
    ).rows[0].household_id;
    const user: Identity = {
      userId: uid,
      familyId: family,
      name: "Pessoa Teste",
      email: "mobile@example.invalid",
      role: "owner",
    };
    const id = randomUUID();
    await db.query(
      "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Teste','Teste','BRL','checking',$3)",
      [id, family, uid],
    );
    await stagePreview(
      db,
      user,
      id,
      { name: "ficticio.csv", bytes: Buffer.from("fake mobile") },
      {
        parser: "test",
        currency: "BRL",
        rows: [
          {
            date: "2026-01-02",
            description: "Pix sem categoria",
            original_description: "Pix sem categoria",
            amount_cents: "-500",
            currency: "BRL",
            locator: "line 1",
            suggested_kind: "expense",
            confidence: 0.5,
          },
        ],
        checks: [{ label: "saldo", passed: true }],
        warnings: [],
        opening: { date: "2025-12-31", cents: "10000" },
        closing: { date: "2026-01-31", cents: "9500" },
      },
    );
    let state = await readState(db, user, "2026-01-01", "BRL");
    assert.equal(state.bankRows.length, 1);
    assert.equal(state.bankRows[0].recorded, false);
    assert.equal(state.importTotals.pending, 1);
    assert.equal((await prepareOpenings(db, user)).changed, 1);
    assert.equal((await prepareOpenings(db, user)).changed, 0);
    state = await readState(db, user, "2026-01-01", "BRL");
    assert.equal(state.bankRows.length, 1);
    assert.equal(
      (await db.query("SELECT 1 FROM economic_events")).rows.length,
      0,
    );
    assert.equal(
      (
        await db.query<{ opening_cents: string }>(
          "SELECT opening_cents::text FROM accounts WHERE id=$1",
          [id],
        )
      ).rows[0].opening_cents,
      "10000",
    );
  } finally {
    await db.close();
  }
});
