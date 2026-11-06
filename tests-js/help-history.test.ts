import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { readHelpHistory } from "../src/server/help-history.ts";
import { retrieveFacts } from "../src/domain/retrieval.ts";
import { helpMonth } from "../src/domain/help-period.ts";

test("Judite resolves dates from the message and conversation without depending on another tab", () => {
  assert.equal(
    helpMonth("Compare outubro e novembro", "2026-10-24"),
    "2026-10",
  );
  assert.equal(helpMonth("Contas em março de 2025", "2026-10-24"), "2025-03");
  assert.equal(helpMonth("Planeje em 2026-11-15", "2026-10-24"), "2026-11");
  assert.equal(helpMonth("Paguei em 15/11/2026", "2026-10-24"), "2026-11");
  assert.equal(
    helpMonth("e os gastos?", "2026-10-24", [
      { role: "user", text: "Como foi setembro?" },
    ]),
    "2026-09",
  );
  assert.equal(
    helpMonth("E hoje?", "2026-10-24", [
      { role: "user", text: "Como foi setembro?" },
    ]),
    "2026-10",
  );
  assert.equal(helpMonth("mês passado", "2026-01-02"), "2025-12");
});
test("historical retrieval includes multiple months, excludes transfer/payment double counts, isolates families and never exports raw descriptions", async () => {
  const db = await openDatabase();
  try {
    const users: Identity[] = [];
    for (let n = 0; n < 2; n++) {
      const userId = await createFamily(db, {
        name: "Fictícia",
        familyName: "Casa " + n,
        email: `history${n}@example.invalid`,
        password: "Sintetica!2026abcd",
      });
      const familyId = (
        await db.query<{ household_id: string }>(
          "SELECT household_id FROM members WHERE user_id=$1",
          [userId],
        )
      ).rows[0].household_id;
      const u: Identity = {
        userId,
        familyId,
        name: "Fictícia",
        email: `history${n}@example.invalid`,
        role: "owner",
      };
      users.push(u);
      const account = randomUUID();
      await asUser(db, userId, async (tx) => {
        await tx.query(
          "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Fictícia','Teste','BRL','checking',$3)",
          [account, familyId, userId],
        );
        for (const [date, kind, amount] of [
          ["2026-01-10", "income", n ? "99999999" : "10000"],
          ["2026-09-12", "expense", "-2000"],
          ["2026-09-13", "card_purchase", "-1000"],
          ["2026-09-14", "card_payment", "-1000"],
          ["2026-09-15", "transfer", "-3000"],
        ]) {
          const eventId = randomUUID();
          await tx.query(
            "INSERT INTO economic_events(id,household_id,account_id,kind,transaction_date,description,original_description,amount_cents,currency,created_by) VALUES($1,$2,$3,$4,$5,'PRIVATE_COUNTERPARTY','PRIVATE_DESCRIPTION',$6,'BRL',$7)",
            [eventId, familyId, account, kind, date, amount, userId],
          );
          await tx.query(
            "INSERT INTO ledger_entries(id,household_id,event_id,account_id,nominal,currency,amount_cents,transaction_date) VALUES($1,$2,$3,$4,NULL,'BRL',$5,$8),($6,$2,$3,NULL,'synthetic-counterpart','BRL',$7,$8)",
            [
              randomUUID(),
              familyId,
              eventId,
              account,
              amount,
              randomUUID(),
              (-BigInt(amount)).toString(),
              date,
            ],
          );
        }
      });
    }
    const history = await readHelpHistory(db, users[0], "BRL");
    assert.equal(history.length, 2);
    assert.equal(history[0].income_cents, "10000");
    assert.equal(history[1].expense_cents, "3000");
    assert.deepEqual(await readHelpHistory(db, users[0], "USD"), []);
    assert.equal(
      (await readHelpHistory(db, users[1], "BRL"))[0].income_cents,
      "99999999",
    );
    const retrieved = retrieveFacts("Compare os gastos nos meses", {
      month: "2026-10",
      currency: "BRL",
      today: "2026-10-24",
      items: [],
      income_cents: "0",
      expense_cents: "0",
      unresolved: 0,
      budgets: [],
      historyMonths: history,
    });
    assert.equal(
      (
        retrieved.facts.find((f) => f.id === "T1")!.data
          .monthly_totals as unknown[]
      ).length,
      2,
    );
    assert.doesNotMatch(
      JSON.stringify(retrieved),
      /PRIVATE_|99999999|history0@example/,
    );
    assert.equal(
      (await db.query("SELECT * FROM economic_events")).rows.length,
      10,
    );
  } finally {
    await db.close();
  }
});
