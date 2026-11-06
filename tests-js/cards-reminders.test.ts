import { saveCardCycle } from "../src/server/card-cycle.ts";
import { cardCyclePeriod } from "../src/domain/card-cycle.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  PluggyReader,
  normalizeObservation,
  type RemoteAccount,
} from "../src/server/pluggy.ts";
import { paymentReminders } from "../src/domain/reminders.ts";
import { readBanks } from "../src/server/banks.ts";
import { readCards } from "../src/server/cards.ts";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { sendDueReminders, testPush } from "../src/server/notifications.ts";
import webpush from "web-push";
test("card reads retain exact installments and bill identity, strip card numbers and never multiply amounts", async () => {
  const card = {
    id: randomUUID(),
    itemId: randomUUID(),
    type: "CREDIT",
    name: "Cartão fictício",
    currencyCode: "BRL",
  } as RemoteAccount;
  const bill = randomUUID(),
    raw = {
      id: "purchase",
      accountId: card.id,
      description: "Parcela fictícia",
      amount: "45.67",
      date: "2026-10-21",
      type: "DEBIT",
      status: "PENDING",
      creditCardMetadata: {
        billId: bill,
        installmentNumber: 2,
        totalInstallments: 10,
        cardNumber: "1234567890123456",
        totalAmount: 456.7,
      },
    };
  const observation = normalizeObservation(raw, card);
  assert.equal(observation.amount_cents, "-4567");
  assert.equal(observation.card_meta?.bill_id, bill);
  assert.equal(observation.card_meta?.installment_number, 2);
  assert.ok(!JSON.stringify(observation).includes("1234567890123456"));
  const calls: string[] = [];
  const reader = new PluggyReader(
    { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    async (input, init) => {
      const url = String(input);
      calls.push(String(init?.method) + " " + url);
      if (url.endsWith("/auth"))
        return Response.json({ apiKey: "synthetic-token" });
      return new Response(
        JSON.stringify({
          page: 1,
          totalPages: 1,
          results: [
            {
              id: bill,
              accountId: card.id,
              dueDate: "2026-11-07T00:00:00",
              totalAmount: 123.45,
              totalAmountCurrencyCode: "BRL",
              financeCharges: [{ amount: 1.02, currencyCode: "BRL" }],
              payments: [
                {
                  id: "payment",
                  paymentDate: "2026-10-07",
                  amount: 100.01,
                  currencyCode: "BRL",
                },
              ],
            },
          ],
        }),
      );
    },
  );
  await reader.authenticate();
  const bills = await reader.bills(card);
  assert.equal(bills[0].total_cents, "12345");
  assert.equal(bills[0].payments[0].cents, "10001");
  assert.equal(bills[0].charges_cents, "102");
  assert.ok(
    calls.every(
      (c) =>
        c.startsWith("GET https://api.pluggy.ai/bills?") ||
        c === "POST https://api.pluggy.ai/auth",
    ),
  );
  const precise = new PluggyReader(
    { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    async (input) =>
      String(input).endsWith("/auth")
        ? Response.json({ apiKey: "x" })
        : new Response(
            JSON.stringify({
              page: 1,
              totalPages: 1,
              results: [
                {
                  id: bill,
                  accountId: card.id,
                  dueDate: "2026-11-07",
                  totalAmount: 123.4567,
                  totalAmountCurrencyCode: "BRL",
                },
              ],
            }),
          ),
  );
  await precise.authenticate();
  const evidence = await precise.bills(card);
  assert.equal(evidence[0].total_cents, null);
  assert.equal(evidence[0].raw_total, "123.4567");
  assert.equal(evidence[0].needs_review, true);
  const wrong = new PluggyReader(
    { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    async (input) =>
      String(input).endsWith("/auth")
        ? Response.json({ apiKey: "x" })
        : Response.json({
            page: 1,
            totalPages: 1,
            results: [
              {
                id: bill,
                accountId: randomUUID(),
                dueDate: "2026-11-07",
                totalAmount: "1",
                totalAmountCurrencyCode: "BRL",
              },
            ],
          }),
  );
  await wrong.authenticate();
  await assert.rejects(wrong.bills(card));
});
test("reminders exclude received income, savings and paid bills, keep missing dates explicit and calculate partial amounts", () => {
  const base = {
    id: "a",
    label: "Conta",
    purpose: "expense",
    status: "open",
    due_date: "2026-10-22",
    planned_cents: "10000",
    paid_cents: null,
  };
  const r = paymentReminders(
    [
      base,
      { ...base, id: "b", purpose: "income" },
      { ...base, id: "c", purpose: "saving" },
      { ...base, id: "d", status: "done" },
      { ...base, id: "e", due_date: null },
      {
        ...base,
        id: "f",
        purpose: "card",
        status: "partial",
        paid_cents: "4000",
        due_date: "2026-10-23",
      },
    ],
    "2026-10-23",
  );
  assert.equal(r.dated.length, 2);
  assert.equal(r.missingDates.length, 1);
  assert.equal(r.dated[0].urgency, "overdue");
  assert.equal(r.dated[1].urgency, "today");
  assert.equal(r.dated[1].remaining_cents, "6000");
});
test("card projections isolate families and separate posted previews, bank pending and recorded purchases; notification leases retry failures without marking delivery", async () => {
  const db = await openDatabase(),
    send = webpush.sendNotification;
  try {
    const userId = await createFamily(db, {
      name: "Teste",
      familyName: "Casa",
      email: "cards-test@example.invalid",
      password: "Sintetica!2026abcd",
    });
    const familyId = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [userId],
      )
    ).rows[0].household_id;
    const user = {
      userId,
      familyId,
      name: "Teste",
      email: "cards-test@example.invalid",
      role: "owner",
    } as Identity;
    const acct = randomUUID(),
      connection = randomUUID(),
      ba = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Cartão teste','Teste','BRL','card',$3)`,
      [acct, familyId, userId],
    );
    await db.query(
      `INSERT INTO bank_credentials(household_id,user_id,sealed) VALUES($1,$2,'synthetic')`,
      [familyId, userId],
    );
    await db.query(
      `INSERT INTO bank_connections(id,household_id,user_id,item_id,label,owner_label,start_date) VALUES($1,$2,$3,$4,'Teste','Teste','2026-01-01')`,
      [connection, familyId, userId, randomUUID()],
    );
    await db.query(
      `INSERT INTO bank_accounts(id,household_id,connection_id,remote_id,label,currency,account_type,local_account_id,balance_cents,credit_due_date) VALUES($1,$2,$3,$4,'Cartão','BRL','CREDIT',$5,5000,(now() AT TIME ZONE 'America/Sao_Paulo')::date)`,
      [ba, familyId, connection, randomUUID(), acct],
    );
    for (const [status, amount] of [
      ["POSTED", "-5000"],
      ["PENDING", "-1000"],
      ["POSTED", "5000"],
    ])
      await db.query(
        `INSERT INTO bank_transactions(id,household_id,bank_account_id,local_account_id,remote_id,transaction_date,description,amount_cents,currency,provider_status,payload_hash,last_seen_run) VALUES($1,$2,$3,$4,$5,'2026-10-21',$6,$7,'BRL',$8,'synthetic',$9)`,
        [
          randomUUID(),
          familyId,
          ba,
          acct,
          randomUUID(),
          amount.startsWith("-") ? "Compra" : "Pagamento recebido",
          amount,
          status,
          randomUUID(),
        ],
      );
    const cards = await readCards(db, user, "2026-10");
    assert.equal(cards[0].preview_cents, "5000");
    assert.equal(cards[0].bank_pending_cents, "1000");
    assert.equal(cards[0].registered_cents, "0");
    assert.equal(cards[0].payments.length, 1);
    const billId = randomUUID();
    await asUser(db, userId, (tx) =>
      tx.query(
        `INSERT INTO bank_card_bills(id,household_id,bank_account_id,remote_id,due_date,total_cents,currency,charges_cents) VALUES($1,$2,$3,$4,'2026-11-07',10000,'BRL',0)`,
        [billId, familyId, ba, randomUUID()],
      ),
    );
    assert.equal((await readCards(db, user, "2026-11"))[0].bills.length, 1);
    assert.equal(
      (await readCards(db, user, "2026-11"))[0].unassigned_cents,
      "6000",
    );
    assert.equal((await readBanks(db, user, 0, "", acct)).total, 3);
    assert.equal((await readBanks(db, user, 0, "", randomUUID())).total, 0);
    const otherId = await createFamily(db, {
      name: "Outra",
      familyName: "Outra",
      email: "cards-other@example.invalid",
      password: "Sintetica!2026abcd",
    });
    const otherFamily = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [otherId],
      )
    ).rows[0].household_id;
    assert.deepEqual(
      await readCards(
        db,
        { ...user, userId: otherId, familyId: otherFamily },
        "2026-10",
      ),
      [],
    );
    assert.equal(
      (
        await asUser(db, otherId, (tx) =>
          tx.query("SELECT id FROM bank_card_bills"),
        )
      ).rows.length,
      0,
    );
    await assert.rejects(
      asUser(db, otherId, (tx) =>
        tx.query(
          `INSERT INTO bank_card_bills(id,household_id,bank_account_id,remote_id,due_date,total_cents,currency,charges_cents) VALUES($1,$2,$3,$4,'2026-11-07',10000,'BRL',0)`,
          [randomUUID(), familyId, ba, randomUUID()],
        ),
      ),
    );
    await saveCardCycle(db, user, {
      account_id: acct,
      close_date: "2026-10-25",
      due_date: "2026-11-03",
    });
    const projected = (await readCards(db, user, "2026-11"))[0];
    assert.equal(projected.projection?.total_cents, "6000");
    assert.equal(projected.projection?.due_date, "2026-11-03");
    assert.equal(projected.unassigned_cents, "0");
    await assert.rejects(
      saveCardCycle(
        db,
        { ...user, role: "reader" },
        { account_id: acct, close_date: "2026-10-25", due_date: "2026-11-03" },
      ),
    );
    await assert.rejects(
      saveCardCycle(
        db,
        { ...user, userId: otherId, familyId: otherFamily },
        { account_id: acct, close_date: "2026-10-25", due_date: "2026-11-03" },
      ),
    );
    await assert.rejects(
      asUser(db, otherId, (tx) =>
        tx.query(
          `INSERT INTO card_cycles(household_id,account_id,closing_day,due_day,due_month_offset,effective_close_date,effective_due_date,created_by) VALUES($1,$2,25,3,1,'2026-10-25','2026-11-03',$3)`,
          [familyId, acct, otherId],
        ),
      ),
    );
    const endpoint = "https://web.push.apple.com/synthetic-only";
    await db.query(
      `INSERT INTO push_subscriptions(id,household_id,user_id,endpoint,keys) VALUES($1,$2,$3,$4,'{}')`,
      [randomUUID(), familyId, userId, endpoint],
    );
    webpush.sendNotification = (async () => {
      throw new Error("synthetic failure");
    }) as typeof webpush.sendNotification;
    assert.deepEqual(await sendDueReminders(db), { sent: 0, failed: 1 });
    assert.equal(
      (
        await db.query<{ last_sent: string | null }>(
          "SELECT last_sent FROM push_subscriptions",
        )
      ).rows[0].last_sent,
      null,
    );
    let calls = 0;
    const deliveredTypes: string[] = [];
    webpush.sendNotification = (async (_subscription, payload, options) => {
      const body = JSON.parse(String(payload));
      deliveredTypes.push(body.type);
      assert.equal(options?.urgency, body.type === "test" ? "high" : "normal");
      assert.equal(options?.TTL, body.type === "test" ? 300 : 43200);
      assert.deepEqual(Object.keys(body).sort(), [
        "body",
        "title",
        "type",
        "url",
      ]);
      calls++;
      return { statusCode: 201, body: "", headers: {} };
    }) as typeof webpush.sendNotification;
    assert.deepEqual(await sendDueReminders(db), { sent: 1, failed: 0 });
    assert.deepEqual(await sendDueReminders(db), { sent: 0, failed: 0 });
    assert.equal(calls, 1);
    await assert.rejects(
      testPush(
        db,
        { ...user, userId: otherId, familyId: otherFamily },
        { endpoint },
      ),
    );
    await testPush(db, user, { endpoint });
    await assert.rejects(testPush(db, user, { endpoint }));
    assert.equal(calls, 2);
    assert.deepEqual(deliveredTypes, ["reminder", "test"]);
    const tomorrowRule = (
      await db.query<{ today: string; closing: string }>(
        `SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today,((now() AT TIME ZONE 'America/Sao_Paulo')::date-1)::text AS closing`,
      )
    ).rows[0];
    await saveCardCycle(db, user, {
      account_id: acct,
      close_date: tomorrowRule.closing,
      due_date: tomorrowRule.today,
    });
    await db.query(
      "UPDATE bank_accounts SET credit_due_date=NULL WHERE id=$1",
      [ba],
    );
    await db.query("UPDATE push_subscriptions SET last_sent=NULL");
    assert.deepEqual(await sendDueReminders(db), { sent: 1, failed: 0 });
    const watching = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Cartão aguardando dados','Teste','BRL','card',$3)`,
      [watching, familyId, userId],
    );
    const placeholder = (await readCards(db, user, "2026-11")).find(
      (c) => c.local_account_id === watching,
    );
    assert.equal(placeholder?.connected, false);
    assert.equal(placeholder?.credit_limit_cents, null);
    assert.equal(placeholder?.balance_cents, null);
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      0,
    );
  } finally {
    webpush.sendNotification = send;
    await db.close();
  }
});

test("card cycle dates cross months and years, clamp short months and never move recorded purchases", () => {
  assert.deepEqual(cardCyclePeriod("2026-11", 25, 3, 1), {
    start_date: "2026-09-26",
    close_date: "2026-10-25",
    due_date: "2026-11-03",
    needs_review: false,
  });
  assert.equal(cardCyclePeriod("2026-12", 25, 3, 1).start_date, "2026-10-26");
  assert.equal(cardCyclePeriod("2027-01", 25, 3, 1).close_date, "2026-12-25");
  assert.equal(cardCyclePeriod("2024-03", 31, 3, 1).close_date, "2024-02-29");
  assert.equal(cardCyclePeriod("2026-02", 30, 31, 0).needs_review, true);
  assert.throws(() => cardCyclePeriod("2026-13", 25, 3, 1));
});
