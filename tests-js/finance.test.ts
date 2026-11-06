import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cents,
  dateOnly,
  normalize,
  postings,
  assertBalanced,
  economicEffect,
  savings,
  budget,
  forecast,
} from "../src/domain/finance.ts";
import { formatted, privateText } from "../src/domain/format.ts";

test("dinheiro usa inteiros exatos, inclusive centavos negativos", () => {
  assert.equal(cents("0,10") + cents("0,20"), cents("0,30"));
  assert.equal(cents("-1.234,56"), -123456n);
  assert.equal(formatted("-50", "BRL"), "R$ -0,50");
  assert.equal(
    privateText("1.250,00 USD convertidos para 6.000,00 BRL", true),
    "•••• USD convertidos para •••• BRL",
  );
  assert.equal(
    formatted("9000000000000000", "BRL"),
    "R$ 90.000.000.000.000,00",
  );
  for (const value of ["1.23,45", "1,2", "NaN", "1e3", "1.234.56", "1,001"])
    assert.throws(() => cents(value));
});
test("datas preservam dia e rejeitam datas inexistentes", () => {
  assert.equal(dateOnly("2026-10-21"), "2026-10-21");
  assert.equal(dateOnly("2024-02-29"), "2024-02-29");
  for (const value of [
    "2026-02-29",
    "2026-04-31",
    "21/10/2026",
    "2026-10-21T00:00:00Z",
  ])
    assert.throws(() => dateOnly(value));
  assert.equal(normalize("  alimentação   Família "), "ALIMENTACAO FAMILIA");
});
test("transferência conserva o saldo consolidado e não é receita nem despesa", () => {
  const entries = postings({
    kind: "transfer",
    amount: -10000n,
    accountId: "a",
    counterId: "b",
    accountKind: "checking",
    counterKind: "checking",
    currency: "BRL",
  });
  assertBalanced(entries);
  assert.equal(
    entries.reduce((s, e) => s + e.cents, 0n),
    0n,
  );
  assert.deepEqual(economicEffect("transfer", -10000n), {
    income: 0n,
    expense: 0n,
  });
});
test("compra de crédito e pagamento da fatura reconhecem uma única despesa", () => {
  const purchase = postings({
    kind: "card_purchase",
    amount: -5000n,
    accountId: "card",
    accountKind: "card",
    currency: "BRL",
  });
  const payment = postings({
    kind: "card_payment",
    amount: -5000n,
    accountId: "bank",
    counterId: "card",
    accountKind: "checking",
    counterKind: "card",
    currency: "BRL",
  });
  assertBalanced(purchase);
  assertBalanced(payment);
  assert.equal(
    [...purchase, ...payment]
      .filter((e) => e.accountId === "card")
      .reduce((s, e) => s + e.cents, 0n),
    0n,
  );
  assert.equal(
    economicEffect("card_purchase", -5000n).expense +
      economicEffect("card_payment", -5000n).expense,
    5000n,
  );
  assert.throws(() =>
    postings({
      kind: "card_purchase",
      amount: -50n,
      accountId: "a",
      accountKind: "checking",
      currency: "BRL",
    }),
  );
});
test("estorno reduz consumo e aplicação/resgate não criam renda ou consumo", () => {
  assert.equal(economicEffect("refund", 2500n).expense, -2500n);
  assert.deepEqual(economicEffect("investment_buy", -10000n), {
    income: 0n,
    expense: 0n,
  });
  assert.deepEqual(economicEffect("investment_sell", 10000n), {
    income: 0n,
    expense: 0n,
  });
  assert.equal(economicEffect("yield", 100n).income, 100n);
});
test("câmbio equilibra cada moeda separadamente e rejeita pares impossíveis", () => {
  const input = {
    kind: "fx" as const,
    amount: -50000n,
    accountId: "brl",
    accountKind: "checking" as const,
    currency: "BRL" as const,
    counterId: "usd",
    counterKind: "checking" as const,
    counterCurrency: "USD" as const,
    counterAmount: 10000n,
  };
  const entries = postings(input);
  assertBalanced(entries);
  assert.equal(entries.length, 4);
  assert.throws(() => postings({ ...input, counterAmount: -10000n }));
  assert.throws(() =>
    assertBalanced([
      { accountId: "a", nominal: null, currency: "BRL", cents: 100n },
      { accountId: "b", nominal: null, currency: "USD", cents: -100n },
    ]),
  );
});
test("poupança, orçamento e projeção distinguem zero, ausência e compromisso realizado", () => {
  assert.equal(savings(100000n, 75000n), "2500");
  assert.equal(savings(0n, 100n), null);
  assert.deepEqual(budget(10000n, 12000n), {
    remaining: -2000n,
    usedBasisPoints: 12000n,
  });
  assert.equal(
    forecast(10000n, [
      { cents: -2000n, realized: true },
      { cents: -3000n, realized: false },
      { cents: 5000n, realized: false },
    ]),
    12000n,
  );
});
