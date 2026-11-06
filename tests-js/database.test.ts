import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { openDatabase, asUser } from "../src/server/db.ts";
import {
  createFamily,
  issueSession,
  identity,
  login,
  hashPassword,
  verifyPassword,
  type Identity,
} from "../src/server/auth.ts";
import {
  stagePreview,
  saveReview,
  remapPreview,
  confirmBatch,
  addEvent,
  accountFor,
  type Preview,
  type StageRow,
  type Review,
} from "../src/server/imports.ts";
import { readState } from "../src/server/state.ts";
let db: PGlite,
  a: Identity,
  b: Identity,
  bank: string,
  other: string,
  card: string,
  usd: string,
  category: string;
async function account(
  user: Identity,
  name: string,
  kind = "checking",
  currency = "BRL",
) {
  const id = randomUUID();
  await asUser(db, user.userId, (tx) =>
    tx.query(
      "INSERT INTO accounts(id,household_id,name,institution,currency,kind,opening_cents,opening_date,created_by) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8)",
      [
        id,
        user.familyId,
        name,
        "Instituição fictícia",
        currency,
        kind,
        "2025-12-31",
        user.userId,
      ],
    ),
  );
  return id;
}
function preview(amount = "-1000", bankId: string | null = null): Preview {
  return {
    parser: "ficticio-v1",
    currency: "BRL",
    checks: [{ label: "Conciliação fictícia", passed: true }],
    warnings: [],
    rows: [
      {
        date: "2026-01-02",
        description: "Exemplo fictício",
        original_description: "Exemplo fictício",
        amount_cents: amount,
        currency: "BRL",
        locator: "linha 1",
        bank_id: bankId,
        suggested_kind: BigInt(amount) > 0n ? "income" : "expense",
        confidence: 0.5,
      },
    ],
  };
}
async function stage(
  p = preview(),
  acct = bank,
  bytes = Buffer.from(randomUUID()),
) {
  return stagePreview(db, a, acct, { name: "ficticio.csv", bytes }, p);
}
async function rows(batch: string) {
  return (
    await asUser(db, a.userId, (tx) =>
      tx.query<StageRow>(
        "SELECT *,transaction_date::text,amount_cents::text,counter_amount_cents::text FROM staged_transactions WHERE batch_id=$1 ORDER BY ordinal",
        [batch],
      ),
    )
  ).rows;
}
function review(r: StageRow, extra: Partial<Review> = {}): Review {
  return {
    id: r.id,
    version: r.version,
    description: r.description,
    kind: r.kind || "expense",
    category_id: category,
    counter_account_id: null,
    counter_currency: null,
    counter_amount_cents: null,
    related_event_id: null,
    link_event_id: null,
    decision: "accept",
    review_note: r.duplicate_hint ? "Compra igual fictícia conferida" : "",
    ...extra,
  };
}
async function count() {
  return Number(
    (
      await asUser(db, a.userId, (tx) =>
        tx.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM economic_events",
        ),
      )
    ).rows[0].count,
  );
}
before(async () => {
  db = await openDatabase();
  for (const [email, name] of [
    ["a@example.invalid", "Família fictícia A"],
    ["b@example.invalid", "Família fictícia B"],
  ])
    await createFamily(db, {
      email,
      name,
      password: "SenhaFicticia!2026",
      familyName: name,
    });
  const users = (
    await db.query<{ id: string; email: string }>(
      "SELECT id,email FROM users ORDER BY email",
    )
  ).rows;
  a = (await identity(db, await issueSession(db, users[0].id)))!;
  b = (await identity(db, await issueSession(db, users[1].id)))!;
  bank = await account(a, "Banco fictício A");
  other = await account(a, "Outro banco fictício");
  card = await account(a, "Cartão fictício", "card");
  usd = await account(a, "Conta dólar fictícia", "checking", "USD");
  await account(b, "Banco exclusivo B");
  category = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{ id: string }>(
        "SELECT id FROM categories WHERE name='Alimentação'",
      ),
    )
  ).rows[0].id;
});
after(async () => {
  await db?.close();
});
test("senhas possuem salt e comparação segura; bootstrap não pode ser repetido", async () => {
  const first = await hashPassword("SenhaFicticia!2026"),
    second = await hashPassword("SenhaFicticia!2026");
  assert.notEqual(first, second);
  assert.ok(await verifyPassword("SenhaFicticia!2026", first));
  assert.equal(await verifyPassword("OutraSenha!2026", first), false);
  await assert.rejects(
    createFamily(
      db,
      {
        email: "c@example.invalid",
        name: "C",
        familyName: "C",
        password: "SenhaFicticia!2026",
      },
      true,
    ),
  );
  assert.equal(await identity(db, "invalido"), null);
});
test("RLS impede leitura, escrita e vínculo entre famílias com papel real sem bypass", async () => {
  const visible = await asUser(db, b.userId, (tx) =>
    tx.query<{ name: string }>("SELECT name FROM accounts"),
  );
  assert.equal(visible.rows.length, 1);
  assert.equal(visible.rows[0].name, "Banco exclusivo B");
  await assert.rejects(
    asUser(db, b.userId, (tx) =>
      tx.query(
        "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          randomUUID(),
          a.familyId,
          "Invasão",
          "Fictício",
          "BRL",
          "checking",
          b.userId,
        ],
      ),
    ),
  );
  const batch = await stage();
  const r = (await rows(batch.id))[0];
  await assert.rejects(saveReview(db, b, batch.id, [review(r)]));
  const role = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{ name: string }>("SELECT current_user AS name"),
    )
  ).rows[0].name;
  assert.equal(role, "family_app");
  const reset = (
    await db.query<{ name: string }>("SELECT current_user AS name")
  ).rows[0].name;
  assert.equal(reset, "postgres");
});
test("leitor consulta mas não altera os dados da família", async () => {
  const id = randomUUID();
  await db.query(
    "INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
    [
      id,
      "leitor@example.invalid",
      "Leitor fictício",
      await hashPassword("SenhaFicticia!2026"),
    ],
  );
  await db.query(
    "INSERT INTO members(household_id,user_id,role) VALUES($1,$2,'reader')",
    [a.familyId, id],
  );
  const reader = (await identity(db, await issueSession(db, id)))!;
  assert.ok(
    (await asUser(db, id, (tx) => tx.query("SELECT id FROM accounts"))).rows
      .length > 0,
  );
  await assert.rejects(
    stagePreview(
      db,
      reader,
      bank,
      { name: "ficticio.csv", bytes: Buffer.from(randomUUID()) },
      preview(),
    ),
  );
});
test("arquivo renomeado e confirmação simultânea não duplicam eventos", async () => {
  const bytes = Buffer.from("arquivo fictício idempotente");
  const p = preview("-1234");
  const first = await stage(p, bank, bytes);
  const repeated = await stagePreview(
    db,
    a,
    bank,
    { name: "renomeado.csv", bytes },
    p,
  );
  assert.equal(first.id, repeated.id);
  assert.ok(repeated.repeated);
  const r = (await rows(first.id))[0];
  await saveReview(db, a, first.id, [review(r)]);
  const before = await count();
  const results = await Promise.all([
    confirmBatch(db, a, first.id),
    confirmBatch(db, a, first.id),
  ]);
  assert.equal(await count(), before + 1);
  assert.equal(
    results.reduce((n, r) => n + r.created, 0),
    1,
  );
});
test("prévia pendente ou com falha de reconciliação não confirma", async () => {
  const pending = await stage();
  await assert.rejects(confirmBatch(db, a, pending.id));
  const p = preview();
  p.checks[0].passed = false;
  const failed = await stage(p);
  await saveReview(
    db,
    a,
    failed.id,
    (await rows(failed.id)).map((r) => review(r)),
  );
  await assert.rejects(confirmBatch(db, a, failed.id));
});
test("revisão otimista impede sobrescrever alterações feitas em outra sessão", async () => {
  const batch = await stage();
  const r = (await rows(batch.id))[0];
  await saveReview(db, a, batch.id, [review(r)]);
  await assert.rejects(saveReview(db, a, batch.id, [review(r)]));
});
test("ID bancário repetido com payload diferente preserva os dois itens", async () => {
  const p = preview("-1500", "CARD-ficticio");
  p.rows.push({
    ...p.rows[0],
    amount_cents: "250",
    description: "Ajuste fictício",
    original_description: "Ajuste fictício",
    suggested_kind: "income",
    locator: "linha 2",
  });
  const batch = await stage(p);
  const items = await rows(batch.id);
  assert.equal(items.length, 2);
  assert.ok(items[1].duplicate_hint);
  assert.equal(items[0].bank_id, items[1].bank_id);
});
test("lote falho faz rollback de eventos já processados e mantém a prévia", async () => {
  const p = preview("-1700");
  p.rows.push({
    ...p.rows[0],
    description: "Outro fictício",
    locator: "linha 2",
  });
  const batch = await stage(p);
  const items = await rows(batch.id);
  await saveReview(db, a, batch.id, [
    review(items[0]),
    review(items[1], { kind: "transfer", counter_account_id: null }),
  ]);
  const before = await count();
  await assert.rejects(confirmBatch(db, a, batch.id));
  assert.equal(await count(), before);
  const status = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{ status: string }>(
        "SELECT status FROM import_batches WHERE id=$1",
        [batch.id],
      ),
    )
  ).rows[0].status;
  assert.equal(status, "preview");
});
test("transferência própria tem duas pernas; segunda origem vincula sem novo evento", async () => {
  const batch = await stage(preview("-4000"));
  await saveReview(
    db,
    a,
    batch.id,
    (await rows(batch.id)).map((r) =>
      review(r, {
        kind: "transfer",
        category_id: null,
        counter_account_id: other,
        counter_currency: "BRL",
      }),
    ),
  );
  await confirmBatch(db, a, batch.id);
  const event = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{ id: string }>(
        "SELECT id FROM economic_events WHERE kind='transfer' ORDER BY created_at DESC LIMIT 1",
      ),
    )
  ).rows[0];
  const counterpart = await stage(preview("4000"), other);
  await saveReview(
    db,
    a,
    counterpart.id,
    (await rows(counterpart.id)).map((r) =>
      review(r, {
        decision: "link",
        link_event_id: event.id,
        review_note: "Duas origens fictícias da mesma transferência",
      }),
    ),
  );
  const before = await count();
  const result = await confirmBatch(db, a, counterpart.id);
  assert.equal(result.linked, 1);
  assert.equal(await count(), before);
  const sum = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{ total: string }>(
        "SELECT sum(amount_cents)::text AS total FROM ledger_entries WHERE event_id=$1",
        [event.id],
      ),
    )
  ).rows[0].total;
  assert.equal(sum, "0");
});
test("cartão e fatura não duplicam consumo; estorno respeita a despesa original", async () => {
  const initial = await readState(db, a, "2026-01-01", "BRL");
  const purchase = await stage(preview("-5000"), card);
  await saveReview(
    db,
    a,
    purchase.id,
    (await rows(purchase.id)).map((r) => review(r, { kind: "card_purchase" })),
  );
  await confirmBatch(db, a, purchase.id);
  const bill = await stage(preview("-5000"));
  await saveReview(
    db,
    a,
    bill.id,
    (await rows(bill.id)).map((r) =>
      review(r, {
        kind: "card_payment",
        category_id: null,
        counter_account_id: card,
        counter_currency: "BRL",
      }),
    ),
  );
  await confirmBatch(db, a, bill.id);
  const state = await readState(db, a, "2026-01-01", "BRL");
  assert.equal(
    BigInt(state.summary.expense_cents) - BigInt(initial.summary.expense_cents),
    5000n,
  );
  const original = state.events.find((e) => e.kind === "card_purchase")!;
  const refund = await stage(preview("2500"), card);
  await saveReview(
    db,
    a,
    refund.id,
    (await rows(refund.id)).map((r) =>
      review(r, { kind: "refund", related_event_id: original.id }),
    ),
  );
  await confirmBatch(db, a, refund.id);
  const tooMuch = await stage(preview("3000"), card);
  await saveReview(
    db,
    a,
    tooMuch.id,
    (await rows(tooMuch.id)).map((r) =>
      review(r, { kind: "refund", related_event_id: original.id }),
    ),
  );
  await assert.rejects(confirmBatch(db, a, tooMuch.id));
});
test("abertura é separada de movimentos; itens anteriores não são somados duas vezes", async () => {
  const late = await account(a, "Conta com abertura recente");
  await asUser(db, a.userId, (tx) =>
    tx.query(
      "UPDATE accounts SET opening_cents=100000,opening_date='2026-01-10' WHERE id=$1",
      [late],
    ),
  );
  const p = await stage(preview("-2000"), late);
  await saveReview(
    db,
    a,
    p.id,
    (await rows(p.id)).map((r) => review(r)),
  );
  await assert.rejects(confirmBatch(db, a, p.id));
  const state = await readState(db, a, "2026-01-01", "BRL");
  assert.equal(
    state.accounts.find((acct) => acct.id === late)?.balance_cents,
    "100000",
  );
});
test("câmbio guarda valores originais e mantém partidas balanceadas por moeda", async () => {
  const p = preview("-50000");
  p.rows[0].suggested_kind = "fx";
  p.rows[0].counter_currency = "USD";
  p.rows[0].counter_amount_cents = "10000";
  const batch = await stage(p);
  await saveReview(
    db,
    a,
    batch.id,
    (await rows(batch.id)).map((r) =>
      review(r, {
        kind: "fx",
        category_id: null,
        counter_account_id: usd,
        counter_currency: "USD",
        counter_amount_cents: "10000",
      }),
    ),
  );
  await confirmBatch(db, a, batch.id);
  const balances = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{ total: string }>(
        "SELECT sum(l.amount_cents)::text AS total FROM ledger_entries l JOIN economic_events e ON e.id=l.event_id WHERE e.kind='fx' GROUP BY l.currency",
      ),
    )
  ).rows;
  assert.equal(balances.length, 2);
  assert.ok(balances.every((r) => r.total === "0"));
});
test("banco rejeita evento sem partidas mesmo quando o serviço é contornado", async () => {
  await assert.rejects(
    asUser(db, a.userId, (tx) =>
      tx.query(
        "INSERT INTO economic_events(id,household_id,account_id,kind,transaction_date,description,original_description,amount_cents,currency,created_by) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)",
        [
          randomUUID(),
          a.familyId,
          bank,
          "expense",
          "2026-01-02",
          "Fictício",
          "-100",
          "BRL",
          a.userId,
        ],
      ),
    ),
    /Evento contábil não balanceado/,
  );
});
test("vínculo de categoria de outra família é recusado pelo banco", async () => {
  const foreignCategory = (
    await asUser(db, b.userId, (tx) =>
      tx.query<{ id: string }>("SELECT id FROM categories LIMIT 1"),
    )
  ).rows[0].id;
  const batch = await stage();
  await assert.rejects(
    saveReview(
      db,
      a,
      batch.id,
      (await rows(batch.id)).map((r) =>
        review(r, { category_id: foreignCategory }),
      ),
    ),
  );
});
test("serviço de lançamento manual usa o mesmo núcleo e registra somente partidas válidas", async () => {
  const r = {
    ...(await rows((await stage(preview("-37"))).id))[0],
    kind: "expense" as const,
    category_id: category,
  };
  const id = await asUser(db, a.userId, async (tx) =>
    addEvent(tx, a, await accountFor(tx, a.familyId, bank), r),
  );
  assert.ok(id);
});
test("sessão expirada é recusada e tentativas de senha são limitadas", async () => {
  const token = await issueSession(db, a.userId);
  await db.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
    [(await import("../src/server/auth.ts")).digest(token)],
  );
  assert.equal(await identity(db, token), null);
  for (let n = 0; n < 5; n++)
    await assert.rejects(
      login(db, "inexistente@example.invalid", "SenhaFicticiaErrada"),
    );
  await assert.rejects(
    login(db, "inexistente@example.invalid", "SenhaFicticiaErrada"),
    /Muitas tentativas/,
  );
});
test("filtros mostram a perna correta da transferência e a moeda correta do câmbio", async () => {
  const destination = await readState(db, a, "2026-01-01", "BRL", other);
  const transfer = destination.events.find((e) => e.kind === "transfer");
  assert.equal(transfer?.amount_cents, "4000");
  const dollars = await readState(db, a, "2026-01-01", "USD", usd);
  assert.equal(
    dollars.events.find((e) => e.kind === "fx")?.amount_cents,
    "10000",
  );
  assert.equal(dollars.summary.income_cents, "0");
  assert.equal(dollars.summary.expense_cents, "0");
});
test("orçamento e seis tipos de observação usam evidências locais, sem inventar economia", async () => {
  await asUser(db, a.userId, async (tx) => {
    await tx.query(
      "INSERT INTO budgets(household_id,category_id,month,currency,planned_cents) VALUES($1,$2,'2026-01-01','BRL',100)",
      [a.familyId, category],
    );
    await tx.query(
      "INSERT INTO accounts(id,household_id,name,institution,currency,kind,created_by) VALUES($1,$2,'Sem abertura fictícia','Banco fictício','BRL','checking',$3)",
      [randomUUID(), a.familyId, a.userId],
    );
  });
  const state = await readState(db, a, "2026-01-01", "BRL");
  const types = new Set(state.insights.map((i) => i.type));
  for (const type of [
    "review",
    "duplicate",
    "opening",
    "budget",
    "card",
    "counterpart",
  ])
    assert.ok(types.has(type), type);
  assert.ok(BigInt(state.budgets[0].remaining_cents) < 0n);
  assert.ok(state.insights.every((i) => i.fact && i.action && i.period));
});
test("descrição revisada não apaga a evidência usada na deduplicação", async () => {
  const p = preview("-7776");
  const first = await stage(p);
  const item = (await rows(first.id))[0];
  await saveReview(db, a, first.id, [
    review(item, { description: "Descrição alterada fictícia" }),
  ]);
  const second = await stage(p);
  assert.equal((await rows(second.id))[0].duplicate_hint, true);
});
test("diferença de conciliação é visível e não modifica a abertura para forçar coincidência", async () => {
  const acct = await account(a, "Conta de conciliação fictícia");
  const p = preview("1000");
  p.opening = { date: "2025-12-31", cents: "5000" };
  p.closing = { date: "2026-01-02", cents: "6000" };
  const batch = await stage(p, acct);
  await saveReview(
    db,
    a,
    batch.id,
    (await rows(batch.id)).map((r) => review(r, { kind: "income" })),
  );
  await confirmBatch(db, a, batch.id);
  const context = (
    await asUser(db, a.userId, (tx) =>
      tx.query<{
        context: {
          reconciliation: { status: string; difference_cents: string };
        };
      }>("SELECT context FROM import_batches WHERE id=$1", [batch.id]),
    )
  ).rows[0].context;
  assert.equal(context.reconciliation.status, "difference");
  assert.equal(context.reconciliation.difference_cents, "-5000");
  assert.equal(
    (await asUser(db, a.userId, (tx) => accountFor(tx, a.familyId, acct)))
      .opening_cents,
    "0",
  );
  const state = await readState(db, a, "2026-01-01", "BRL");
  assert.ok(state.insights.some((i) => i.type === "reconciliation"));
});
test("conta errada pode ser corrigida na prévia, sem permitir alterar lote confirmado", async () => {
  const batch = await stage(preview("-816"));
  const item = (await rows(batch.id))[0];
  await saveReview(db, a, batch.id, [review(item)]);
  await remapPreview(db, a, batch.id, other);
  const revised = (await rows(batch.id))[0];
  assert.equal(revised.reviewed, false);
  assert.equal(revised.decision, "pending");
  assert.ok(revised.version > item.version);
  await saveReview(db, a, batch.id, [review(revised)]);
  await confirmBatch(db, a, batch.id);
  await assert.rejects(remapPreview(db, a, batch.id, bank));
});
