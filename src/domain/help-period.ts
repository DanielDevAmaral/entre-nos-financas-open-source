const months = [
  "janeiro",
  "fevereiro",
  "marco",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];
const normalize = (v: string) =>
  v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
function explicitMonth(question: string, today: string): string | null {
  const q = normalize(question);
  const iso = q.match(/\b(20\d{2})-(0[1-9]|1[0-2])(?:-\d{2})?\b/);
  if (iso) return iso[1] + "-" + iso[2];
  const date = q.match(/\b(?:\d{2}\/)?(0[1-9]|1[0-2])\/(20\d{2})\b/);
  if (date) return date[2] + "-" + date[1];
  if (/mes passado|mes anterior|proximo mes|mes que vem/.test(q)) {
    const d = new Date(today.slice(0, 7) + "-01T12:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + (/passado|anterior/.test(q) ? -1 : 1));
    return d.toISOString().slice(0, 7);
  }
  const index = months.findIndex((m) => new RegExp("\\b" + m + "\\b").test(q));
  if (index >= 0)
    return (
      (q.match(/\b20\d{2}\b/)?.[0] ?? today.slice(0, 4)) +
      "-" +
      String(index + 1).padStart(2, "0")
    );
  return /hoje|ontem|este mes|nesse mes|mes atual/.test(q)
    ? today.slice(0, 7)
    : null;
}
/** Never let another tab's selected month restrict Judite's retrieval. */
export function helpMonth(
  question: string,
  today: string,
  history: { role: string; text: string }[] = [],
) {
  return (
    explicitMonth(question, today) ??
    [...history]
      .reverse()
      .filter((m) => m.role === "user")
      .map((m) => explicitMonth(m.text, today))
      .find(Boolean) ??
    today.slice(0, 7)
  );
}
