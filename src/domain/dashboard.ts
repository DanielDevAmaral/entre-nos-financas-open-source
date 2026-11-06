import { economicEffect, type Kind } from "./finance.ts";

export type PlanGroup = "income" | "fixed" | "variable" | "saving";
export function planGroup(item: {
  purpose: string;
  label: string;
  cost_type?: string | null;
}): PlanGroup {
  if (item.purpose === "income") return "income";
  if (item.purpose === "saving") return "saving";
  if (item.cost_type === "fixed" || item.cost_type === "variable")
    return item.cost_type;
  // A suggestion for the existing plan, never a change to its amounts or payment status.
  const label = item.label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return item.purpose === "expense" &&
    /\b(aluguel|condominio|internet|energia|luz|agua|gas|telefone|celular|seguro|escola|creche|mensalidade|financiamento|prestacao|assinatura|netflix|spotify)\b/.test(
      label,
    )
    ? "fixed"
    : "variable";
}

export function categorySpending(
  events: {
    kind: Kind;
    amount_cents: string;
    category_id: string | null;
    category_name: string | null;
  }[],
) {
  const groups = new Map<string, { name: string; cents: bigint }>();
  for (const event of events) {
    const expense = economicEffect(
      event.kind,
      BigInt(event.amount_cents),
    ).expense;
    if (!expense) continue;
    const id = event.category_id ?? "uncategorized";
    const group = groups.get(id) ?? {
      name: event.category_name ?? "Sem categoria",
      cents: 0n,
    };
    group.cents += expense;
    groups.set(id, group);
  }
  const rows = [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  const slices = rows
    .filter((row) => row.cents > 0n)
    .sort((a, b) =>
      a.cents > b.cents
        ? -1
        : a.cents < b.cents
          ? 1
          : a.name.localeCompare(b.name),
    );
  const adjustments = rows.filter((row) => row.cents < 0n);
  const total = slices.reduce((sum, row) => sum + row.cents, 0n);
  return { slices, adjustments, total };
}
