import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import {
  PluggyReader,
  decimalCents,
  sealCredentials,
  openCredentials,
  normalizeObservation,
  type RemoteAccount,
} from "../src/server/pluggy.ts";
import {
  saveBankCredentials,
  connectBank,
  readBanks,
  renewBank,
  mapBankAccount,
  syncBank,
  reviewBankTransaction,
  pauseBank,
} from "../src/server/banks.ts";
import { createManualEvent } from "../src/server/manual.ts";
import { stagePreview } from "../src/server/imports.ts";
import { readState } from "../src/server/state.ts";

process.env.BANK_CONNECTIONS_KEY = randomBytes(32).toString("base64");
const credentials = {
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret-private",
};
test("bank credentials use dedicated authenticated encryption bound to family and user; decimal and card signs are exact", () => {
  const sealed = sealCredentials(credentials, "family:user");
  assert.ok(!sealed.includes(credentials.clientSecret));
  assert.deepEqual(openCredentials(sealed, "family:user"), credentials);
  assert.throws(() => openCredentials(sealed, "family:spouse"));
  assert.throws(() =>
    openCredentials(sealed.slice(0, -4) + "AAAA", "family:user"),
  );
  assert.equal(decimalCents("1234.56"), 123456n);
  assert.equal(decimalCents("-0.01"), -1n);
  assert.throws(() => decimalCents("1.005"));
  const account = {
    id: randomUUID(),
    itemId: randomUUID(),
    type: "CREDIT",
    name: "Cartão fictício",
    currencyCode: "BRL",
  } as RemoteAccount;
  const raw = {
    id: "card-purchase",
    accountId: account.id,
    description: "Compra",
    amount: "100.01",
    date: "2026-10-05T00:00:00Z",
    type: "DEBIT",
    status: "POSTED",
  };
  assert.equal(normalizeObservation(raw, account).amount_cents, "-10001");
  assert.equal(
    normalizeObservation({ ...raw, type: "CREDIT", amount: "-100.01" }, account)
      .amount_cents,
    "10001",
  );
  assert.throws(() =>
    normalizeObservation({ ...raw, accountId: randomUUID() }, account),
  );
});
test("reader is fixed-origin, cursor-safe, bounded and has no upstream mutation except authentication", async () => {
  const item = randomUUID(),
    acct = randomUUID(),
    calls: { url: string; method: string }[] = [];
  let pages = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, method: init?.method ?? "GET" });
    if (url.pathname === "/auth")
      return Response.json({ apiKey: "synthetic-api-token" });
    if (url.pathname.startsWith("/items/"))
      return Response.json({ id: item, status: "UPDATED" });
    if (url.pathname === "/accounts")
      return Response.json({
        total: 1,
        results: [
          {
            id: acct,
            itemId: item,
            type: "BANK",
            name: "Fictícia",
            balance: 100.01,
            currencyCode: "BRL",
          },
        ],
      });
    pages++;
    return Response.json({
      results: [
        {
          id: "txn-" + pages,
          accountId: acct,
          description: "Fictícia",
          date: "2026-10-05",
          amount: -10.01,
          type: "DEBIT",
          status: "POSTED",
        },
      ],
      next: pages === 1 ? "?accountId=" + acct + "&after=cursorA" : null,
    });
  };
  const reader = new PluggyReader(credentials, transport);
  await reader.authenticate();
  await reader.item(item);
  const accounts = await reader.accounts(item);
  assert.equal(accounts[0].balance, "100.01");
  assert.equal(
    (await reader.transactions(accounts[0], "2026-10-01")).length,
    2,
  );
  assert.ok(calls.every((c) => c.url.startsWith("https://api.pluggy.ai/")));
  assert.ok(
    calls.every(
      (c) =>
        c.method === "GET" ||
        (c.url === "https://api.pluggy.ai/auth" && c.method === "POST"),
    ),
  );
  const bad = new PluggyReader(credentials, async (input) =>
    String(input).endsWith("/auth")
      ? Response.json({ apiKey: "x" })
      : Response.json({ results: [], next: "https://attacker.invalid/secret" }),
  );
  await bad.authenticate();
  await assert.rejects(bad.transactions(accounts[0], "2026-10-01"));
  let cycle = 0;
  const cycling = new PluggyReader(credentials, async (input) =>
    String(input).endsWith("/auth")
      ? Response.json({ apiKey: "x" })
      : Response.json({
          results: [],
          next: "?accountId=" + acct + "&after=" + ["A", "B", "A"][cycle++],
        }),
  );
  await cycling.authenticate();
  await assert.rejects(cycling.transactions(accounts[0], "2026-10-01"));
  assert.equal(cycle, 3);
});

test("family bank staging isolates secrets, requires account mapping and review, links old evidence and records transfer once", async () => {
  const db = await openDatabase();
  try {
    const userId = await createFamily(db, {
      name: "Titular fictício",
      familyName: "Família de teste",
      email: "bank-test@example.invalid",
      password: "SenhaFicticia!2026",
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
      name: "Titular fictício",
      email: "bank-test@example.invalid",
      role: "owner",
    } as Identity;
    const spouse: Identity = {
      ...user,
      userId: randomUUID(),
      name: "Esposa fictícia",
      role: "editor",
    };
    await db.query(
      "INSERT INTO users(id,email,name,password_hash) VALUES($1,'spouse-bank@example.invalid','Esposa fictícia','not-a-login-hash')",
      [spouse.userId],
    );
    await db.query(
      "INSERT INTO members(household_id,user_id,role) VALUES($1,$2,'editor')",
      [familyId, spouse.userId],
    );
    const otherId = await createFamily(db, {
      name: "Outra",
      familyName: "Outra casa",
      email: "bank-other@example.invalid",
      password: "SenhaFicticia!2026",
    });
    const otherFamily = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [otherId],
      )
    ).rows[0].household_id;
    const other = { ...user, userId: otherId, familyId: otherFamily };
    const localA = randomUUID(),
      localB = randomUUID();
    for (const [id, name] of [
      [localA, "Conta A"],
      [localB, "Conta B"],
    ])
      await asUser(db, userId, (tx) =>
        tx.query(
          "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,$3,'Teste','BRL','checking',$4)",
          [id, familyId, name, userId],
        ),
      );
    const category = (
      await asUser(db, userId, (tx) =>
        tx.query<{ id: string }>(
          "SELECT id FROM categories WHERE household_id=$1 LIMIT 1",
          [familyId],
        ),
      )
    ).rows[0].id;
    let item = randomUUID(),
      remoteA = randomUUID(),
      remoteB = randomUUID();
    let expired = false,
      fail = false;
    const remoteCard = randomUUID();
    let includeCard = false;
    let rowsCard: Record<string, unknown>[] = [];
    let rowsA: Record<string, unknown>[] = [],
      rowsB: Record<string, unknown>[] = [];
    const factory = () =>
      new PluggyReader(credentials, async (input) => {
        const url = new URL(String(input));
        if (fail && url.pathname !== "/auth")
          return new Response("private provider failure", { status: 503 });
        if (url.pathname === "/auth")
          return Response.json({ apiKey: "test-only-token" });
        if (url.pathname.startsWith("/items/"))
          return Response.json({
            id: item,
            status: "UPDATED",
            consentExpiresAt: expired ? "2020-01-01T00:00:00Z" : null,
            lastUpdatedAt: "2026-10-20T12:00:00Z",
            connector: { name: "MeuPluggy" },
          });
        if (url.pathname === "/accounts")
          return Response.json({
            total: includeCard ? 3 : 2,
            results: [
              {
                id: remoteA,
                itemId: item,
                type: "BANK",
                name: "Banco A",
                balance: 123.45,
                currencyCode: "BRL",
              },
              {
                id: remoteB,
                itemId: item,
                type: "BANK",
                name: "Banco B",
                balance: 5,
                currencyCode: "BRL",
              },
              ...(includeCard
                ? [
                    {
                      id: remoteCard,
                      itemId: item,
                      type: "CREDIT",
                      name: "Cartão novo",
                      creditData: {
                        creditLimit: 1234.56,
                        availableCreditLimit: 1000.01,
                        balanceDueDate: "2026-11-03",
                        balanceCloseDate: "2026-10-25",
                      },
                      balance: 0,
                      currencyCode: "BRL",
                    },
                  ]
                : []),
            ],
          });
        return Response.json({
          results:
            url.searchParams.get("accountId") === remoteA
              ? rowsA
              : url.searchParams.get("accountId") === remoteB
                ? rowsB
                : rowsCard,
          next: null,
        });
      });
    await saveBankCredentials(
      db,
      user,
      { ...credentials, consent: true },
      factory,
    );
    const stored = (
      await asUser(db, userId, (tx) =>
        tx.query<{ sealed: string }>("SELECT sealed FROM bank_credentials"),
      )
    ).rows;
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].sealed.includes(credentials.clientSecret));
    assert.equal(
      (
        await asUser(db, spouse.userId, (tx) =>
          tx.query("SELECT * FROM bank_credentials"),
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await asUser(db, other.userId, (tx) =>
          tx.query("SELECT * FROM bank_credentials"),
        )
      ).rows.length,
      0,
    );
    const connection = await connectBank(
      db,
      user,
      {
        item_id: item,
        label: "Banco fictício",
        start_date: "2026-10-01",
        consent: true,
      },
      factory,
    );
    assert.equal(
      (
        await connectBank(
          db,
          user,
          {
            item_id: item,
            label: "Duplicado",
            start_date: "2026-10-01",
            consent: true,
          },
          factory,
        )
      ).id,
      connection.id,
    );
    let state = await readBanks(db, user);
    assert.equal(
      state.connections.length,
      1,
      "repeating setup reuses the existing connection",
    );
    assert.equal((await readBanks(db, spouse)).hasCredentials, false);
    const isolated = await readBanks(db, other);
    assert.equal(isolated.connections.length, 0);
    assert.equal(isolated.accounts.length, 0);
    assert.equal(isolated.reviews.length, 0);
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      0,
      "credentials and connecting a bank never confirm a movement",
    );
    assert.ok(!JSON.stringify(state).includes("synthetic-secret"));
    assert.equal(state.accounts.length, 2);
    const a = state.accounts.find((a) => a.label === "Banco A")!,
      b = state.accounts.find((a) => a.label === "Banco B")!;
    await assert.rejects(
      mapBankAccount(db, spouse, { id: a.id, account_id: localA }),
    );
    await assert.rejects(
      mapBankAccount(db, other, { id: a.id, account_id: localA }),
    );
    assert.deepEqual(
      await syncBank(db, other, { id: connection.id, force: true }, () => {
        throw new Error("Foreign-family request must never reach the provider");
      }),
      { skipped: true, observed: 0 },
    );
    await mapBankAccount(db, user, { id: a.id, account_id: localA });
    await mapBankAccount(db, user, { id: b.id, account_id: localB });
    await mapBankAccount(db, user, { id: a.id, account_id: localA });
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      0,
      "mapping existing accounts, including a retry, never creates financial events",
    );
    await assert.rejects(
      mapBankAccount(db, user, { id: a.id, account_id: localB }),
    );
    const old = await createManualEvent(db, user, {
      account_id: localA,
      date: "2026-10-05",
      description: "Compra antiga",
      amount: "-10,01",
      kind: "expense",
      category_id: category,
      counter_account_id: null,
      counter_currency: null,
      counter_amount: null,
      related_event_id: null,
    });
    const row = (
      id: string,
      accountId: string,
      amount: number,
      type = "DEBIT",
      date = "2026-10-05",
    ) => ({
      id,
      accountId,
      date,
      description: "Movimento " + id,
      amount,
      type,
      status: "POSTED",
      currencyCode: "BRL",
      providerId: "provider-" + id,
    });
    rowsA = [
      row("old", remoteA, -10.01),
      row("transfer-out", remoteA, -300, "DEBIT", "2026-10-06"),
      { ...row("pending", remoteA, 10, "CREDIT"), status: "PENDING" },
    ];
    rowsB = [row("transfer-in", remoteB, 300, "CREDIT", "2026-10-06")];
    const read = async () => {
      await db.query(
        "UPDATE bank_connections SET last_attempt_at=NULL,last_read_at=NULL WHERE id=$1",
        [connection.id],
      );
      return syncBank(db, user, { id: connection.id, force: true }, factory);
    };
    await read();
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      1,
    );
    state = await readBanks(db, user);
    assert.equal(state.reviews.length, 4);
    const oldRow = state.reviews.find((r) => r.remote_id === "old")!;
    assert.equal(oldRow.candidates.events[0].id, old);
    await assert.rejects(
      reviewBankTransaction(db, user, {
        id: oldRow.id,
        version: oldRow.version,
        decision: "record",
        kind: "expense",
        category_id: category,
      }),
    );
    await assert.rejects(
      reviewBankTransaction(db, other, {
        id: oldRow.id,
        version: oldRow.version,
        decision: "link",
        event_id: old,
      }),
    );
    await reviewBankTransaction(db, spouse, {
      id: oldRow.id,
      version: oldRow.version,
      decision: "link",
      event_id: old,
    });
    const outgoing = state.reviews.find((r) => r.remote_id === "transfer-out")!;
    await reviewBankTransaction(db, user, {
      id: outgoing.id,
      version: outgoing.version,
      decision: "record",
      kind: "transfer",
      counter_account_id: localB,
    });
    state = await readBanks(db, user);
    const incoming = state.reviews.find((r) => r.remote_id === "transfer-in")!;
    assert.equal(incoming.candidates.events.length, 1);
    await reviewBankTransaction(db, user, {
      id: incoming.id,
      version: incoming.version,
      decision: "link",
      event_id: incoming.candidates.events[0].id,
    });
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      2,
    );
    const pending = state.reviews.find((r) => r.remote_id === "pending")!;
    await assert.rejects(
      reviewBankTransaction(db, user, {
        id: pending.id,
        version: pending.version,
        decision: "record",
        kind: "income",
        category_id: category,
      }),
    );
    await read();
    assert.equal(
      (await db.query("SELECT id FROM bank_transactions")).rows.length,
      4,
    );
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      2,
    );
    const financial = await readState(db, user, "2026-10-01", "BRL");
    assert.equal(financial.summary.income_cents, "0");
    assert.equal(financial.summary.expense_cents, "1001");
    assert.ok(financial.events.some((e) => e.sources.length > 0));
    // A provider correction or disappearance cannot rewrite a previously saved event.
    rowsA[0] = { ...rowsA[0], amount: -11 };
    await read();
    state = await readBanks(db, user);
    const changed = state.reviews.find((r) => r.remote_id === "old")!;
    assert.equal(changed.changed, true);
    assert.equal(
      (
        await db.query<{ amount_cents: string }>(
          "SELECT amount_cents::text FROM economic_events WHERE id=$1",
          [old],
        )
      ).rows[0].amount_cents,
      "-1001",
    );
    await assert.rejects(
      reviewBankTransaction(db, user, {
        id: changed.id,
        version: changed.version,
        decision: "refresh",
      }),
    );
    rowsA = rowsA.filter((r) => r.id !== "old");
    await read();
    assert.equal(
      (await readBanks(db, user)).reviews.find((r) => r.remote_id === "old")!
        .missing,
      true,
    );
    expired = true;
    await assert.rejects(read());
    expired = false;
    fail = true;
    await assert.rejects(read());
    fail = false;
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      2,
    );
    // A previously staged statement is attached as evidence rather than left to create a second event.
    const staged = await stagePreview(
      db,
      user,
      localA,
      { name: "ficticio.csv", bytes: Buffer.from("only-fake") },
      {
        parser: "test",
        currency: "BRL",
        rows: [
          {
            date: "2026-10-07",
            description: "Compra do extrato",
            original_description: "Compra do extrato",
            amount_cents: "-2000",
            currency: "BRL",
            locator: "row1",
            suggested_kind: "expense",
            confidence: 1,
          },
        ],
        checks: [{ label: "test", passed: true }],
        warnings: [],
      },
    );
    rowsA.push(row("source", remoteA, -20, "DEBIT", "2026-10-07"));
    await read();
    state = await readBanks(db, user);
    const evidence = state.reviews.find((r) => r.remote_id === "source")!;
    assert.equal(evidence.candidates.staged.length, 1);
    await reviewBankTransaction(db, user, {
      id: evidence.id,
      version: evidence.version,
      decision: "record",
      kind: "expense",
      category_id: category,
      staged_id: evidence.candidates.staged[0].id,
    });
    assert.equal(
      (await db.query("SELECT id FROM economic_events")).rows.length,
      3,
    );
    assert.equal(
      (
        await db.query(
          "SELECT * FROM event_sources WHERE staged_id IN (SELECT id FROM staged_transactions WHERE batch_id=$1)",
          [staged.id],
        )
      ).rows.length,
      1,
    );
    await assert.rejects(
      reviewBankTransaction(db, user, {
        id: evidence.id,
        version: evidence.version,
        decision: "record",
        kind: "expense",
        category_id: category,
      }),
    );
    const pendingId = state.reviews.find((r) => r.remote_id === "pending")?.id;
    rowsA = rowsA.map((r) =>
      r.id === "pending" ? { ...r, amount: 15, status: "POSTED" } : r,
    );
    await read();
    const correction = (await readBanks(db, user)).reviews.find(
      (r) => r.id === pendingId,
    )!;
    assert.equal(correction.changed, true);
    await reviewBankTransaction(db, user, {
      id: correction.id,
      version: correction.version,
      decision: "refresh",
    });
    assert.equal(
      (await readBanks(db, user)).reviews.find((r) => r.id === pendingId)
        ?.amount_cents,
      "1500",
    );
    const savedMoney = JSON.stringify(
      (
        await db.query(
          "SELECT id,event_id,account_id,currency,amount_cents::text FROM ledger_entries ORDER BY id",
        )
      ).rows,
    );
    item = randomUUID();
    remoteA = randomUUID();
    remoteB = randomUUID();
    rowsA = rowsA.map((r) => ({
      ...r,
      id: String(r.id) + "-renewed",
      accountId: remoteA,
    }));
    rowsB = rowsB.map((r) => ({
      ...r,
      id: String(r.id) + "-renewed",
      accountId: remoteB,
    }));
    await assert.rejects(
      renewBank(db, spouse, { id: connection.id, item_id: item }, factory),
    );
    const renewal = await renewBank(
      db,
      user,
      { id: connection.id, item_id: item },
      factory,
    );
    assert.equal(renewal.previous.length, 2);
    await assert.rejects(
      renewBank(
        db,
        user,
        { id: connection.id, item_id: item, confirm: true, mappings: [] },
        factory,
      ),
    );
    await renewBank(
      db,
      user,
      {
        id: connection.id,
        item_id: item,
        confirm: true,
        mappings: [
          { bank_account_id: a.id, remote_account_id: remoteA },
          { bank_account_id: b.id, remote_account_id: remoteB },
        ],
      },
      factory,
    );
    await read();
    state = await readBanks(db, user);
    assert.equal(
      state.accounts.find((a) => a.local_account_id === localA)?.id,
      a.id,
    );
    assert.equal(
      (
        await db.query("SELECT id FROM accounts WHERE household_id=$1", [
          familyId,
        ])
      ).rows.length,
      2,
    );
    const newSource = state.reviews.find(
      (r) => r.remote_id === "source-renewed",
    )!;
    const priorEvent = newSource.candidates.events[0];
    assert.equal(priorEvent.bank_seen, true);
    await assert.rejects(
      reviewBankTransaction(db, user, {
        id: newSource.id,
        version: newSource.version,
        decision: "link",
        event_id: priorEvent.id,
      }),
    );
    await reviewBankTransaction(db, user, {
      id: newSource.id,
      version: newSource.version,
      decision: "link",
      event_id: priorEvent.id,
      duplicate: true,
      note: "Mesma compra após renovar a autorização do banco.",
    });
    await read();
    const originalSource = (
      await db.query<{ missing: boolean }>(
        "SELECT missing FROM bank_transactions WHERE remote_id='source'",
      )
    ).rows[0];
    assert.equal(originalSource.missing, false);
    assert.equal(
      JSON.stringify(
        (
          await db.query(
            "SELECT id,event_id,account_id,currency,amount_cents::text FROM ledger_entries ORDER BY id",
          )
        ).rows,
      ),
      savedMoney,
    );
    // New local accounts are created only by explicit choice. A card-side payment
    // must debit the paying checking account and credit the card, with no expense.
    includeCard = true;
    await read();
    const card = (await readBanks(db, user)).accounts.find(
      (a) => a.label === "Cartão novo",
    )!;
    await mapBankAccount(db, user, {
      id: card.id,
      account_id: null,
      name: "Cartão local",
    });
    const mappedCard = (await readBanks(db, user)).accounts.find(
      (a) => a.id === card.id,
    )!;
    assert.ok(mappedCard.local_account_id);
    rowsCard = [row("card-payment", remoteCard, -125, "CREDIT", "2026-10-09")];
    await read();
    const payment = (await readBanks(db, user)).reviews.find(
      (r) => r.remote_id === "card-payment",
    )!;
    await assert.rejects(
      reviewBankTransaction(db, user, {
        id: payment.id,
        version: payment.version,
        decision: "record",
        kind: "income",
        category_id: category,
      }),
    );
    await reviewBankTransaction(db, user, {
      id: payment.id,
      version: payment.version,
      decision: "record",
      kind: "card_payment",
      counter_account_id: localA,
    });
    const paymentEvent = (
      await db.query<{ event_id: string }>(
        "SELECT event_id FROM bank_transactions WHERE id=$1",
        [payment.id],
      )
    ).rows[0].event_id;
    const legs = (
      await db.query<{ account_id: string; amount_cents: string }>(
        "SELECT account_id,amount_cents::text FROM ledger_entries WHERE event_id=$1",
        [paymentEvent],
      )
    ).rows;
    assert.equal(
      legs.find((l) => l.account_id === localA)?.amount_cents,
      "-12500",
    );
    assert.equal(
      legs.find((l) => l.account_id === mappedCard.local_account_id)
        ?.amount_cents,
      "12500",
    );
    const limit = (
      await db.query<{
        credit_limit_cents: string;
        available_credit_cents: string;
      }>(
        "SELECT credit_limit_cents::text,available_credit_cents::text FROM bank_accounts WHERE remote_id=$1",
        [remoteCard],
      )
    ).rows[0];
    assert.equal(limit.credit_limit_cents, "123456");
    assert.equal(limit.available_credit_cents, "100001");
    const totals = (await readState(db, user, "2026-10-01", "BRL")).summary;
    assert.equal(totals.income_cents, "0");
    assert.equal(totals.expense_cents, "3001");
    await pauseBank(db, user, { id: connection.id, enabled: false });
    assert.equal(
      (await syncBank(db, user, { id: connection.id, force: true }, factory))
        .skipped,
      true,
    );
    await assert.rejects(
      pauseBank(db, spouse, { id: connection.id, enabled: true }),
    );
  } finally {
    await db.close();
  }
});
