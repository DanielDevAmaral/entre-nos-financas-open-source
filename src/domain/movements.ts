import { economicEffect, type Kind } from "./finance.ts";

export type Movement = {
  id: string;
  date: string;
  description: string;
  account: string;
  category: string | null;
  amount: string;
  kind: string | null;
  review: boolean;
  duplicate: boolean;
};
export type MovementFilter =
  "all" | "income" | "expense" | "transfer" | "card" | "review";
export function movementGroup(row: Movement): MovementFilter {
  if (row.review) return "review";
  if (["income", "yield"].includes(row.kind ?? "")) return "income";
  if (["expense", "fee", "refund"].includes(row.kind ?? "")) return "expense";
  if (["transfer", "fx"].includes(row.kind ?? "")) return "transfer";
  if (["card_purchase", "card_payment"].includes(row.kind ?? "")) return "card";
  return "all";
}
const normalized = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
export function visibleMovements(
  rows: Movement[],
  query: string,
  filter: MovementFilter,
  account: string,
) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  return rows
    .filter((row) => {
      const text = normalized(
        [row.description, row.account, row.category ?? ""].join(" "),
      );
      return (
        (!account || row.account === account) &&
        (filter === "all" || movementGroup(row) === filter) &&
        terms.every((term) => text.includes(term))
      );
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
export function movementTotals(rows: Movement[]) {
  let income = 0n,
    expense = 0n,
    review = 0,
    transfers = 0;
  for (const row of rows) {
    if (row.review) {
      review++;
      continue;
    }
    if (["transfer", "fx"].includes(row.kind ?? "")) transfers++;
    const effect = economicEffect(row.kind as Kind, BigInt(row.amount));
    income += effect.income;
    expense += effect.expense;
  }
  return {
    income: income.toString(),
    expense: expense.toString(),
    review,
    transfers,
  };
}
