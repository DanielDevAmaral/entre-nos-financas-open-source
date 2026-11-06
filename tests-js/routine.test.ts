import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { openDatabase, asUser } from "../src/server/db.ts";
import { applyPlanning } from "../src/server/assisted.ts";
import {
  readRoutine,
  saveItem,
  checkItem,
  copyMonth,
} from "../src/server/routine.ts";
import {
  pushStatus,
  safePushEndpoint,
  subscribePush,
} from "../src/server/notifications.ts";
async function person(
  db: Pick<PGlite, "query" | "exec" | "transaction">,
  suffix: string,
) {
  const id = await createFamily(db, {
    name: "Família de teste",
    familyName: "Casa",
    email: suffix + "@example.invalid",
    password: "senha-sintetica-segura",
  });
  const family = (
    await db.query<{ household_id: string }>(
      "SELECT household_id FROM members WHERE user_id=$1",
      [id],
    )
  ).rows[0].household_id;
  return {
    userId: id,
    familyId: family,
    name: "Família de teste",
    email: suffix + "@example.invalid",
    role: "owner",
  } as Identity;
}
test("existing spreadsheet becomes a checklist; paid and partial notes survive without new financial events", async () => {
  const db = new PGlite();
  await db.waitReady;
  try {
    for (const name of [
      "001_initial",
      "002_fingerprints",
      "003_ledger_dates",
      "004_planning",
    ])
      await db.exec(await readFile("db/migrations/" + name + ".sql", "utf8"));
    const user = await person(db, "spreadsheet");
    const base = {
      month: "2026-10-01",
      sheet: "Mês",
      cell: "B3",
      label: "Energia",
      purpose: "expense",
      planned_cents: "20000",
      actual_cents: "18000",
      derived: true,
      notes: "PAGO",
      error: null,
      actual_error: null,
      formula: null,
    };
    await applyPlanning(
      db,
      user,
      {
        entries: [
          base,
          { ...base, cell: "B4", label: "Curso", notes: "METADE PAGO" },
          { ...base, cell: "B5", label: "Água", notes: "PENDENTE" },
          { ...base, cell: "B6", label: "Telefone", notes: "NÃO PAGO" },
        ],
      },
      "synthetic-checklist",
      "teste.xlsx",
    );
    await db.exec(
      await readFile("db/migrations/005_family_routine.sql", "utf8"),
    );
    await db.exec(
      await readFile("db/migrations/008_monthly_cost_type.sql", "utf8"),
    );
    for (const migration of ["009_bank_readonly", "010_bank_analysis_income"])
      await db.exec(
        await readFile("db/migrations/" + migration + ".sql", "utf8"),
      );
    const { items } = await readRoutine(db, user, "2026-10");
    assert.equal(items.length, 4);
    assert.equal(items.find((i) => i.label === "Energia")?.status, "done");
    assert.equal(items.find((i) => i.label === "Curso")?.status, "partial");
    assert.equal(items.find((i) => i.label === "Água")?.status, "open");
    assert.equal(items.find((i) => i.label === "Telefone")?.status, "open");
    assert.equal(
      (await db.query("SELECT * FROM economic_events")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
test("monthly checklist isolates families, blocks stale edits and readers, resets paid status when copying and clamps due dates", async () => {
  const db = await openDatabase();
  try {
    const user = await person(db, "routine"),
      other = await person(db, "other");
    const input = {
      month: "2026-01",
      label: "Conta de casa",
      purpose: "expense",
      currency: "BRL",
      amount: "100,00",
      due_date: "2026-01-31",
    };
    const { id } = await saveItem(db, user, input);
    assert.equal((await readRoutine(db, other, "2026-01")).items.length, 0);
    await assert.rejects(
      checkItem(db, other, { id, version: 1, status: "done" }),
    );
    await checkItem(db, user, {
      id,
      version: 1,
      status: "done",
      date: "2026-01-30",
    });
    await assert.rejects(
      checkItem(db, user, { id, version: 1, status: "open" }),
    );
    await copyMonth(db, user, { from: "2026-01", to: "2026-02" });
    const copied = (await readRoutine(db, user, "2026-02")).items[0];
    assert.equal(copied.status, "open");
    assert.equal(copied.due_date, "2026-02-28");
    assert.equal(copied.paid_cents, null);
    assert.equal(copied.event_id, null);
    await assert.rejects(
      copyMonth(db, user, { from: "2026-01", to: "2026-02" }),
    );
    await assert.rejects(
      saveItem(db, user, { ...input, due_date: "2026-03-01" }),
    );
    await assert.rejects(saveItem(db, user, { ...input, amount: "-1,00" }));
    const reader = await person(db, "reader");
    await db.query("UPDATE members SET role='reader' WHERE user_id=$1", [
      reader.userId,
    ]);
    await assert.rejects(saveItem(db, reader, input));
    assert.equal(
      (await db.query("SELECT * FROM economic_events")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
test("push endpoints reject internal addresses, private signing keys are inaccessible to family role and devices stay user-private", async () => {
  for (const url of [
    "http://127.0.0.1/x",
    "https://127.0.0.1/x",
    "https://evil.example/x",
    "https://fcm.googleapis.com.evil.example/x",
    "https://user@web.push.apple.com/x",
    "https://web.push.apple.com:8443/x",
  ])
    assert.equal(safePushEndpoint(url), false);
  assert.equal(
    safePushEndpoint("https://web.push.apple.com/opaque-subscription"),
    true,
  );
  const db = await openDatabase();
  try {
    const user = await person(db, "push"),
      other = await person(db, "push-other");
    const status = await pushStatus(db, user);
    assert.ok(status.publicKey);
    assert.equal(status.enabledDevices, 0);
    await assert.rejects(
      asUser(db, user.userId, (tx) =>
        tx.query("SELECT * FROM notification_keys"),
      ),
    );
    await subscribePush(db, user, {
      endpoint: "https://web.push.apple.com/" + randomUUID(),
      keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
    });
    assert.equal(
      (
        await asUser(db, other.userId, (tx) =>
          tx.query("SELECT * FROM push_subscriptions"),
        )
      ).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
