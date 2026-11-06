import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  analyzeObservations,
  incomeDate,
  fifthBusinessDay,
  followingMonth,
  type Observation,
} from "../src/domain/bank-analysis.ts";
import { openDatabase, asUser } from "../src/server/db.ts";
import { createFamily, type Identity } from "../src/server/auth.ts";
import { configureIncome, analyzeBanks } from "../src/server/bank-analysis.ts";
import { readRoutine, copyMonth, saveItem } from "../src/server/routine.ts";
const row = (v: Partial<Observation> = {}): Observation => ({
  id: randomUUID(),
  local_account_id: "checking",
  transaction_date: "2026-10-23",
  amount_cents: "-5000",
  currency: "BRL",
  description: "PIX ENVIADO",
  provider_status: "POSTED",
  owner_id: "owner",
  status: "pending",
  ...v,
});
test("salary schedule anticipates Saturday/Sunday only; budget rolls into next year; variable salary uses a window", () => {
  assert.equal(incomeDate("2026-10"), "2026-10-23");
  assert.equal(incomeDate("2026-07"), "2026-07-24");
  assert.equal(incomeDate("2026-11"), "2026-11-25");
  assert.equal(followingMonth("2026-12"), "2027-01");
  assert.equal(fifthBusinessDay("2026-11"), "2026-11-06");
  assert.throws(() => incomeDate("2026-13"));
});

test("income hints use only explicitly supplied family rules and the matching account", () => {
  const sample = row({
    amount_cents: "10000",
    description: "PIX Empresa Ficticia",
    local_account_id: "checking",
  });
  const rule = {
    account_id: "checking",
    match_text: "Empresa Ficticia",
    label: "Recebimento configurado",
    budget_offset: 1,
  };
  assert.equal(
    analyzeObservations([sample], [], []).get(sample.id)?.group,
    "unclear",
  );
  assert.equal(
    analyzeObservations([sample], [], [], [rule]).get(sample.id)?.group,
    "income",
  );
  assert.equal(
    analyzeObservations(
      [sample],
      [],
      [],
      [{ ...rule, account_id: "other" }],
    ).get(sample.id)?.group,
    "unclear",
  );
});
test("reconciliation separates repeat evidence, own transfer, card payment and investment; equal amounts alone never prove a transfer", () => {
  const a = row(),
    b = row({
      local_account_id: "other",
      amount_cents: "5000",
      description: "PIX RECEBIDO",
    });
  let result = analyzeObservations([a, b], [], []);
  assert.equal(result.get(a.id)?.group, "transfer");
  assert.deepEqual(result.get(a.id)?.related_ids, [b.id]);
  result = analyzeObservations(
    [a, { ...b, description: "RESGATE RDB" }],
    [],
    [],
  );
  assert.equal(result.get(a.id)?.group, "unclear");
  assert.equal(result.get(b.id)?.group, "investment");
  result = analyzeObservations([a, { ...b, owner_id: "someone-else" }], [], []);
  assert.equal(result.get(a.id)?.group, "unclear");
  result = analyzeObservations(
    [
      { ...a, description: "PAGAMENTO FATURA" },
      { ...b, description: "PAGAMENTO RECEBIDO" },
    ],
    [],
    [],
  );
  assert.equal(result.get(a.id)?.group, "card");
  const evidence = {
    id: "event",
    account_id: a.local_account_id,
    transaction_date: a.transaction_date,
    amount_cents: a.amount_cents,
    currency: "BRL",
    description: "PIX ENVIADO",
  };
  result = analyzeObservations([a], [evidence], []);
  assert.equal(result.get(a.id)?.group, "history");
  assert.deepEqual(result.get(a.id)?.event_ids, ["event"]);
  result = analyzeObservations(
    [a],
    [],
    [{ ...evidence, filename: "original.pdf" }],
  );
  assert.equal(result.get(a.id)?.group, "statement");
  result = analyzeObservations([a, { ...a, id: "repeat" }], [], []);
  assert.equal(result.get(a.id)?.group, "duplicate");
  assert.equal(
    analyzeObservations([{ ...a, provider_status: "PENDING" }], [], []).get(
      a.id,
    )?.group,
    "pending",
  );
  assert.equal(
    analyzeObservations(
      [row({ description: "ESTORNO", amount_cents: "5000" })],
      [],
      [],
    )
      .values()
      .next().value?.group,
    "unclear",
  );
});
test("income automation reuses the plan, remains open and is idempotent; readers and other families cannot write rules", async () => {
  const db = await openDatabase();
  try {
    const id = await createFamily(db, {
      name: "Teste",
      familyName: "Casa",
      email: "income-analysis@example.invalid",
      password: "Ficticia!2026abcd",
    });
    const family = (
      await db.query<{ household_id: string }>(
        "SELECT household_id FROM members WHERE user_id=$1",
        [id],
      )
    ).rows[0].household_id;
    const u = {
      userId: id,
      familyId: family,
      name: "Teste",
      email: "income-analysis@example.invalid",
      role: "owner",
    } as Identity;
    const account = randomUUID(),
      item = randomUUID();
    await db.query(
      `INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Conta teste','Banco teste','BRL','checking',$3)`,
      [account, family, id],
    );
    const current = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/Sao_Paulo",
      })
        .format(new Date())
        .slice(0, 7),
      budget = followingMonth(current);
    await asUser(db, id, (tx) =>
      tx.query(
        `INSERT INTO monthly_items(id,household_id,month,label,purpose,currency,planned_cents,created_by) VALUES($1,$2,$3,'Emprego teste','income','BRL',800000,$4)`,
        [item, family, budget + "-01", id],
      ),
    );
    const rule = {
      account_id: account,
      label: "Emprego teste",
      match_text: "EMPREGADOR TESTE",
      day: 25,
      expected_cents: "800000",
      effective_month: current,
    };
    await configureIncome(db, u, rule);
    await configureIncome(db, u, rule);
    await analyzeBanks(db, u);
    const plans = await readRoutine(db, u, budget);
    assert.equal(plans.items.length, 1);
    assert.equal(plans.items[0].id, item);
    assert.equal(plans.items[0].status, "open");
    assert.equal(plans.items[0].funding?.expected_date, incomeDate(current));
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM economic_events",
        )
      ).rows[0].n,
      0,
    );
    await assert.rejects(configureIncome(db, { ...u, role: "reader" }, rule));
    const outsider = await createFamily(db, {
      name: "Outra",
      familyName: "Outra casa",
      email: "income-other@example.invalid",
      password: "Ficticia!2026abcd",
    });
    const visible = await asUser(db, outsider, (tx) =>
      tx.query("SELECT id FROM income_rules"),
    );
    assert.equal(visible.rows.length, 0);
    const changed = await asUser(db, outsider, (tx) =>
      tx.query(
        `UPDATE income_rules SET enabled=false WHERE household_id=$1 RETURNING id`,
        [family],
      ),
    );
    assert.equal(changed.rows.length, 0);
    await assert.rejects(
      asUser(db, outsider, (tx) =>
        tx.query(
          `INSERT INTO income_rules(id,household_id,account_id,label,match_text,day,expected_cents,effective_month,created_by) VALUES($1,$2,$3,'Fora','FORA',25,1,$4,$5)`,
          [randomUUID(), family, account, current + "-01", outsider],
        ),
      ),
    );
    const connection = randomUUID(),
      bankAccount = randomUUID(),
      credit = randomUUID();
    await db.query(
      `INSERT INTO bank_credentials(household_id,user_id,sealed) VALUES($1,$2,'synthetic-not-a-secret')`,
      [family, id],
    );
    await db.query(
      `INSERT INTO bank_connections(id,household_id,user_id,item_id,label,owner_label,start_date) VALUES($1,$2,$3,$4,'Banco','Titular',$5)`,
      [connection, family, id, randomUUID(), current + "-01"],
    );
    await db.query(
      `INSERT INTO bank_accounts(id,household_id,connection_id,remote_id,label,currency,account_type,local_account_id) VALUES($1,$2,$3,$4,'Conta','BRL','BANK',$5)`,
      [bankAccount, family, connection, randomUUID(), account],
    );
    await db.query(
      `INSERT INTO bank_transactions(id,household_id,bank_account_id,local_account_id,remote_id,transaction_date,description,amount_cents,currency,provider_status,payload_hash,last_seen_run) VALUES($1,$2,$3,$4,'salary', $5,'EMPREGADOR TESTE',800000,'BRL','POSTED','synthetic',$6)`,
      [credit, family, bankAccount, account, incomeDate(current), randomUUID()],
    );
    await analyzeBanks(db, u);
    let funded = (await readRoutine(db, u, budget)).items[0];
    assert.equal(funded.funding?.state, "detected");
    assert.equal(funded.status, "open");
    assert.equal(funded.event_id, null);
    await db.query(
      `UPDATE bank_transactions SET amount_cents=810000 WHERE id=$1`,
      [credit],
    );
    await analyzeBanks(db, u);
    funded = (await readRoutine(db, u, budget)).items[0];
    assert.equal(funded.funding?.state, "review");
    assert.equal(
      (
        await db.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM economic_events",
        )
      ).rows[0].n,
      0,
    );
    await configureIncome(db, u, {
      ...rule,
      label: "Trabalho variável",
      match_text: "WISE",
      receipt_mode: "business_window",
      budget_offset: 0,
    });
    const variable = (await readRoutine(db, u, current)).items.find(
      (i) => i.label === "Trabalho variável",
    );
    assert.ok(variable);
    assert.equal(variable.funding?.expected_date, fifthBusinessDay(current));
    assert.equal(variable.status, "open");
    await saveItem(db, u, {
      month: budget,
      label: "Conta de teste",
      purpose: "expense",
      currency: "BRL",
      amount: "100,00",
      due_date: null,
    });
    const target = followingMonth(budget);
    await copyMonth(db, u, { from: budget, to: target });
    const copied = (await readRoutine(db, u, target)).items;
    assert.equal(copied.filter((i) => i.label === "Emprego teste").length, 1);
    assert.ok(copied.some((i) => i.label === "Conta de teste"));
    await assert.rejects(copyMonth(db, u, { from: budget, to: target }));
    const before = (
      await db.query("SELECT * FROM income_occurrences ORDER BY id")
    ).rows;
    await analyzeBanks(db, u);
    assert.deepEqual(
      (await db.query("SELECT * FROM income_occurrences ORDER BY id")).rows,
      before,
    );
  } finally {
    await db.close();
  }
});
