import type { Currency } from "./finance.ts";
export function plainMoney(value: string): string {
  const n = BigInt(value),
    abs = n < 0n ? -n : n;
  return (
    (n < 0n ? "-" : "") +
    (abs / 100n).toString() +
    "," +
    (abs % 100n).toString().padStart(2, "0")
  );
}
export function formatted(value: string, currency: Currency): string {
  const n = BigInt(value),
    abs = n < 0n ? -n : n;
  return `${{ BRL: "R$", USD: "US$", EUR: "€" }[currency]} ${n < 0n ? "-" : ""}${(abs / 100n).toLocaleString("pt-BR")},${(abs % 100n).toString().padStart(2, "0")}`;
}
export function brDate(day: string): string {
  return day.slice(0, 10).split("-").reverse().join("/");
}
export function privateText(value: string, hidden: boolean): string {
  return hidden ? value.replace(/[-+]?\d[\d.]*,\d{2}/g, "••••") : value;
}
