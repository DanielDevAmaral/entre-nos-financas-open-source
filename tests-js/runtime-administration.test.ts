import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, identity, issueSession } from "../src/server/auth.ts";
import {
  registerFamily,
  listFamilies,
  isAdministrator,
} from "../src/server/administration.ts";
import { createManualEvent } from "../src/server/manual.ts";
import { consumeLimit } from "../src/server/rate-limit.ts";
import { sendDueReminders } from "../src/server/notifications.ts";
import webpush from "web-push";
test("runtime without owner/admin privilege preserves auth, finance and reminders; only designated administrator creates isolated couples atomically", async () => {
  const db = await openDatabase();
  const password = "Synthetic!2026abcd";
  const originalSend = webpush.sendNotification;
  try {
    const make = async (email: string) => {
      const id = await createFamily(db, {
        name: "Administrador fictício",
        email,
        password,
        familyName: "Synthetic",
      });
      return (await identity(db, await issueSession(db, id)))!;
    };
    const admin = await make("administrator@example.invalid"),
      other = await make("other-owner@example.invalid");
    await db.query("INSERT INTO platform_administrators(user_id) VALUES($1)", [
      admin.userId,
    ]);
    const account = randomUUID();
    await asUser(db, admin.userId, (tx) =>
      tx.query(
        "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Synthetic','Test','BRL','checking',$3)",
        [account, admin.familyId, admin.userId],
      ),
    );
    await db.exec(
      "CREATE ROLE synthetic_runtime LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;GRANT family_runtime TO synthetic_runtime;SET SESSION AUTHORIZATION synthetic_runtime",
    );
    for (const sql of [
      "CREATE TABLE public.forbidden(id integer)",
      "DROP TABLE accounts",
      "ALTER TABLE users ADD COLUMN forbidden text",
      "CREATE ROLE forbidden",
      "SELECT * FROM accounts",
      "SELECT * FROM bank_credentials",
      "INSERT INTO platform_administrators(user_id) SELECT id FROM users",
    ])
      await assert.rejects(db.exec(sql));
    assert.equal(await isAdministrator(db, admin.userId), true);
    assert.equal(await isAdministrator(db, other.userId), false);
    const token = await issueSession(db, admin.userId);
    assert.equal((await identity(db, token))?.userId, admin.userId);
    await consumeLimit(db, "test", "synthetic", 10, 60);
    assert.deepEqual(await sendDueReminders(db), { sent: 0, failed: 0 });
    const request = {
      request_id: randomUUID(),
      familyName: "New synthetic couple",
      first: { name: "One", email: "first@example.invalid", password },
      second: { name: "Two", email: "second@example.invalid", password },
      currentPassword: password,
    };
    await assert.rejects(registerFamily(db, other, request));
    await assert.rejects(listFamilies(db, other));
    await assert.rejects(
      registerFamily(db, admin, {
        ...request,
        currentPassword: "Incorrect!2026abcd",
      }),
    );
    const result = await registerFamily(db, admin, request);
    assert.ok(result.id !== admin.familyId);
    assert.equal((await registerFamily(db, admin, request)).id, result.id);
    assert.equal((await listFamilies(db, admin))[0].people.length, 2);
    const first = (
      await db.query<{ id: string }>(
        "SELECT id FROM users WHERE email='first@example.invalid'",
      )
    ).rows[0];
    const newUser = (await identity(db, await issueSession(db, first.id)))!;
    assert.equal(newUser.familyId, result.id);
    assert.equal(await isAdministrator(db, newUser.userId), false);
    await asUser(db, newUser.userId, async (tx) => {
      assert.equal((await tx.query("SELECT 1 FROM accounts")).rows.length, 0);
      assert.equal(
        (await tx.query("SELECT 1 FROM categories")).rows.length,
        14,
      );
    });
    await assert.rejects(
      registerFamily(db, admin, {
        ...request,
        request_id: randomUUID(),
        first: { ...request.first, email: "rollback@example.invalid" },
      }),
    );
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM users WHERE email='rollback@example.invalid'",
        )
      ).rows.length,
      0,
    );
    const event = await createManualEvent(db, admin, {
      request_id: randomUUID(),
      account_id: account,
      date: "2026-10-23",
      description: "Synthetic income",
      amount: "10,00",
      kind: "income",
      category_id: (
        await asUser(db, admin.userId, (tx) =>
          tx.query<{ id: string }>("SELECT id FROM categories LIMIT 1"),
        )
      ).rows[0].id,
      counter_account_id: null,
      counter_currency: null,
      counter_amount: null,
      related_event_id: null,
    });
    assert.ok(event);
    for (const person of [admin, newUser])
      await asUser(db, person.userId, async (tx) => {
        await tx.query(
          "INSERT INTO monthly_items(id,household_id,month,label,purpose,currency,planned_cents,due_date,created_by) VALUES($1,$2,date_trunc('month',now())::date,'Synthetic reminder','expense','BRL',1000,(now() AT TIME ZONE 'America/Sao_Paulo')::date,$3)",
          [randomUUID(), person.familyId, person.userId],
        );
        await tx.query(
          "INSERT INTO push_subscriptions(id,household_id,user_id,endpoint,keys) VALUES($1,$2,$3,$4,'{}')",
          [
            randomUUID(),
            person.familyId,
            person.userId,
            "https://web.push.apple.com/synthetic-" + person.userId,
          ],
        );
      });
    let deliveries = 0;
    webpush.sendNotification = (async () => {
      deliveries++;
      return { statusCode: 201, body: "", headers: {} };
    }) as typeof webpush.sendNotification;
    assert.deepEqual(await sendDueReminders(db), { sent: 2, failed: 0 });
    assert.equal(deliveries, 2);
    assert.deepEqual(await sendDueReminders(db), { sent: 0, failed: 0 });
    await asUser(db, newUser.userId, async (tx) =>
      assert.equal(
        (await tx.query("SELECT 1 FROM economic_events WHERE id=$1", [event]))
          .rows.length,
        0,
      ),
    );
    await db.exec("RESET SESSION AUTHORIZATION");
    for (let i = 0; i < 25; i++)
      await db.query(
        "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Test','unused')",
        [randomUUID(), `cap${i}@example.invalid`],
      );
    await db.exec("SET SESSION AUTHORIZATION synthetic_runtime");
    await assert.rejects(
      registerFamily(db, admin, {
        ...request,
        request_id: randomUUID(),
        first: { ...request.first, email: "limit1@example.invalid" },
        second: { ...request.second, email: "limit2@example.invalid" },
      }),
      /30/,
    );
  } finally {
    webpush.sendNotification = originalSend;
    await db.close();
  }
});
