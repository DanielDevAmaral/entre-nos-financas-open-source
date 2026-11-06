export const kinds = [
  "income",
  "expense",
  "transfer",
  "card_purchase",
  "card_payment",
  "investment_buy",
  "investment_sell",
  "yield",
  "refund",
  "fee",
  "fx",
] as const;
export type Kind = (typeof kinds)[number];
export type Currency = "BRL" | "USD" | "EUR";
export type AccountKind = "checking" | "card" | "investment" | "benefit";
export type Posting = {
  accountId: string | null;
  nominal: string | null;
  currency: Currency;
  cents: bigint;
};

export function cents(value: string): bigint {
  if (value.length > 32) throw new Error("Valor fora do limite.");
  const text = value.trim();
  if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2}$/.test(text))
    throw new Error("Use valor no formato 1.234,56.");
  const negative = text.startsWith("-");
  const digits = text.replace(/[+.,-]/g, "");
  const result = BigInt(digits) * (negative ? -1n : 1n);
  if (result > 9_000_000_000_000_000n || result < -9_000_000_000_000_000n)
    throw new Error("Valor fora do limite.");
  return result;
}
export function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Data inválida.");
  const parsed = new Date(value + "T12:00:00Z");
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error("Data inválida.");
  return value;
}
export function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}
export function economicEffect(
  kind: Kind,
  amount: bigint,
): { income: bigint; expense: bigint } {
  if (kind === "income" || kind === "yield")
    return { income: amount, expense: 0n };
  if (kind === "expense" || kind === "card_purchase" || kind === "fee")
    return { income: 0n, expense: -amount };
  if (kind === "refund") return { income: 0n, expense: -amount };
  return { income: 0n, expense: 0n };
}
export function postings(input: {
  kind: Kind;
  amount: bigint;
  accountId: string;
  currency: Currency;
  accountKind: AccountKind;
  counterId?: string;
  counterKind?: AccountKind;
  counterCurrency?: Currency;
  counterAmount?: bigint;
}): Posting[] {
  const {
    kind,
    amount,
    accountId,
    currency,
    accountKind,
    counterId,
    counterKind,
  } = input;
  if (amount === 0n)
    throw new Error("Movimento com valor zero não é permitido.");
  if (kind === "fx") {
    const other = input.counterAmount;
    if (
      !counterId ||
      counterId === accountId ||
      !input.counterCurrency ||
      input.counterCurrency === currency ||
      !other ||
      amount * other >= 0n
    )
      throw new Error(
        "Câmbio exige outra conta, outra moeda e valores com sinais opostos.",
      );
    return [
      { accountId, nominal: null, currency, cents: amount },
      { accountId: null, nominal: "fx_bridge", currency, cents: -amount },
      {
        accountId: counterId,
        nominal: null,
        currency: input.counterCurrency,
        cents: other,
      },
      {
        accountId: null,
        nominal: "fx_bridge",
        currency: input.counterCurrency,
        cents: -other,
      },
    ];
  }
  const positive = ["income", "yield", "refund", "investment_sell"];
  const negative = [
    "expense",
    "card_purchase",
    "fee",
    "card_payment",
    "investment_buy",
  ];
  if (
    (positive.includes(kind) && amount < 0n) ||
    (negative.includes(kind) && amount > 0n)
  )
    throw new Error("O sinal do valor não corresponde ao tipo.");
  if (kind === "card_purchase" && accountKind !== "card")
    throw new Error("Compra de crédito exige uma conta de cartão.");
  if (
    kind === "card_payment" &&
    (accountKind === "card" || counterKind !== "card")
  )
    throw new Error(
      "Pagamento exige conta de origem e conta de cartão de destino.",
    );
  if (
    (kind === "investment_buy" && counterKind !== "investment") ||
    (kind === "investment_sell" && counterKind !== "investment")
  )
    throw new Error("Selecione a conta de investimento correspondente.");
  const pair = [
    "transfer",
    "card_payment",
    "investment_buy",
    "investment_sell",
  ].includes(kind);
  if (pair && (!counterId || counterId === accountId))
    throw new Error("Selecione outra conta como contrapartida.");
  return [
    { accountId, nominal: null, currency, cents: amount },
    {
      accountId: pair ? counterId! : null,
      nominal: pair ? null : kind,
      currency,
      cents: -amount,
    },
  ];
}
export function assertBalanced(entries: Posting[]): void {
  const sums = new Map<string, bigint>();
  for (const entry of entries)
    sums.set(entry.currency, (sums.get(entry.currency) ?? 0n) + entry.cents);
  if (entries.length < 2 || [...sums.values()].some((n) => n !== 0n))
    throw new Error("Evento contábil desequilibrado.");
}
export function savings(income: bigint, expense: bigint): string | null {
  return income > 0n
    ? (((income - expense) * 10000n) / income).toString()
    : null;
}
export function budget(planned: bigint, spent: bigint) {
  return {
    remaining: planned - spent,
    usedBasisPoints: planned > 0n ? (spent * 10000n) / planned : null,
  };
}
export function forecast(
  balance: bigint,
  schedules: { cents: bigint; realized: boolean }[],
): bigint {
  return schedules
    .filter((s) => !s.realized)
    .reduce((sum, s) => sum + s.cents, balance);
}
