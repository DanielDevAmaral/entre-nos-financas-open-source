export const homeCards = [
  ["summary", "Resumo do mês"],
  ["receipts", "Recebimentos para o próximo mês"],
  ["alerts", "Alarmes e vencimentos"],
  ["cards", "Cartões do mês"],
  ["income", "Entradas previstas"],
  ["fixed", "Custos fixos"],
  ["variable", "Custos variáveis"],
  ["saving", "Reservas e objetivos"],
  ["categories", "Gráfico por categoria"],
] as const;
export type HomeCardId = (typeof homeCards)[number][0];
export type Preferences = {
  accent: string;
  theme: "system" | "light" | "dark";
  card_order: HomeCardId[];
  hidden_cards: HomeCardId[];
  revision: number;
  has_photo: boolean;
  onboarding_done: boolean;
};
export const defaultPreferences: Preferences = {
  accent: "#c5ab8b",
  theme: "system",
  card_order: homeCards.map((c) => c[0]),
  hidden_cards: [],
  revision: 0,
  has_photo: false,
  onboarding_done: false,
};
export function accentForeground(hex: string) {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const l = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? "#161616" : "#ffffff";
}

export function reorderCard(
  order: HomeCardId[],
  id: HomeCardId,
  target: HomeCardId,
  after = false,
): HomeCardId[] {
  if (id === target || !order.includes(id) || !order.includes(target))
    return order;
  const next = order.filter((x) => x !== id);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, id);
  return next;
}
export function moveVisibleCard(
  order: HomeCardId[],
  hidden: HomeCardId[],
  id: HomeCardId,
  delta: number,
) {
  const visible = order.filter((x) => !hidden.includes(x)),
    index = visible.indexOf(id),
    target = visible[index + delta];
  return index < 0 || !target
    ? order
    : reorderCard(order, id, target, delta > 0);
}
