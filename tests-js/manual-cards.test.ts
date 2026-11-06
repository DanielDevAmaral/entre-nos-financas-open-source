import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { saveManualCard } from "../src/server/manual-cards.ts";
import { readCards } from "../src/server/cards.ts";
import { sendDueReminders } from "../src/server/notifications.ts";
import webpush from "web-push";

test("manual card bills upsert without financial postings, isolate families, validate exact cents and remind only open bills", async () => {
  const db = await openDatabase(),
    send = webpush.sendNotification;
  try {
    const make = async (email: string) => {
      const userId = await createFamily(db, {
        name: "Teste",
        familyName: "Casa",
        email,
        password: "Sintetica!2026abcd",
      });
      const familyId = (
        await db.query<{ household_id: string }>(
          "SELECT household_id FROM members WHERE user_id=$1",
          [userId],
        )
      ).rows[0].household_id;
      return {
        userId,
        familyId,
        name: "Teste",
        email,
        role: "owner",
      } as Identity;
    };
    const u = await make("manual@example.invalid"),
      other = await make("manual-other@example.invalid"),
      account = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Porto','Porto','BRL','card',$3)`,
      [account, u.familyId, u.userId],
    );
    const today = (
        await db.query<{ today: string }>(
          "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today",
        )
      ).rows[0].today,
      month = today.slice(0, 7);
    const input = {
      account_id: account,
      month,
      limit: "10.000,01",
      amount: "1.234,56",
      due_date: today,
      paid: false,
    };
    const snapshot = async () => {
      const out = [];
      for (const t of [
        "economic_events",
        "ledger_entries",
        "monthly_items",
        "planning_lines",
      ])
        out.push(
          (
            await db.query(
              `SELECT to_jsonb(x)::text AS row FROM ${t} x ORDER BY to_jsonb(x)::text`,
            )
          ).rows,
        );
      return JSON.stringify(out);
    };
    const before = await snapshot();
    await saveManualCard(db, u, input);
    await saveManualCard(db, u, { ...input, amount: "1.111,11" });
    let c = (await readCards(db, u, month))[0];
    assert.equal(c.manual_limit_cents, "1000001");
    assert.equal(c.manual_bill?.amount_cents, "111111");
    assert.equal(c.registered_cents, "0");
    assert.equal(c.preview_cents, "0");
    assert.equal(c.connected, false);
    assert.equal(
      (await db.query("SELECT * FROM manual_card_bills")).rows.length,
      1,
    );
    await assert.rejects(saveManualCard(db, { ...u, role: "reader" }, input));
    await assert.rejects(saveManualCard(db, other, input));
    await assert.rejects(saveManualCard(db, u, { ...input, amount: "1,234" }));
    await assert.rejects(saveManualCard(db, u, { ...input, limit: "-1,00" }));
    await assert.rejects(
      saveManualCard(db, u, { ...input, due_date: "2026-02-30" }),
    );
    await assert.rejects(saveManualCard(db, u, { ...input, amount: "" }));
    assert.equal(
      (
        await asUser(db, other.userId, (tx) =>
          tx.query("SELECT * FROM manual_card_bills"),
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      asUser(db, other.userId, (tx) =>
        tx.query(
          `INSERT INTO manual_card_settings(household_id,account_id,limit_cents,updated_by) VALUES($1,$2,1,$3)`,
          [u.familyId, account, other.userId],
        ),
      ),
    );
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    await db.query(
      `INSERT INTO push_subscriptions(id,household_id,user_id,endpoint,keys) VALUES($1,$2,$3,'https://web.push.apple.com/synthetic-manual',$4)`,
      [
        randomUUID(),
        u.familyId,
        u.userId,
        JSON.stringify({ p256dh: "synthetic", auth: "synthetic" }),
      ],
    );
    webpush.sendNotification = (async () => ({
      statusCode: 201,
      body: "",
      headers: {},
    })) as typeof send;
    assert.equal((await sendDueReminders(db)).sent, 1);
    await db.query("UPDATE push_subscriptions SET last_sent=NULL");
    await saveManualCard(db, u, { ...input, paid: true });
    assert.equal((await sendDueReminders(db)).sent, 0);
    await saveManualCard(db, u, { ...input, amount: "0,00", paid: false });
    assert.equal((await sendDueReminders(db)).sent, 0);
    c = (await readCards(db, u, month))[0];
    assert.equal(c.manual_bill?.amount_cents, "0");
    assert.equal(await snapshot(), before);
  } finally {
    webpush.sendNotification = send;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    await db.close();
  }
});
