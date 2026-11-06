"use client";
import { useState } from "react";
import { categorySpending } from "../src/domain/dashboard.ts";
import { formatted } from "../src/domain/format.ts";
import type { Currency } from "../src/domain/finance.ts";
import type { EventRow } from "../src/server/state.ts";
import type { MonthlyItem } from "../src/server/routine.ts";
import { CategoryIcon } from "./family-categories";
const colors = [
  "#c5ab8b",
  "#7d9c91",
  "#b8806b",
  "#8f91b0",
  "#d0ba75",
  "#7295aa",
  "#bd91a3",
  "#8d9771",
];
export function SpendingPie({
  events,
  currency,
  hidden,
  items = [],
  categories = [],
}: {
  events: EventRow[];
  currency: Currency;
  hidden: boolean;
  items?: MonthlyItem[];
  categories?: { id: string; name: string }[];
}) {
  const [mode, setMode] = useState<"registered" | "planned">(() =>
    categorySpending(events).total > 0n ? "registered" : "planned",
  );
  const [selected, setSelected] = useState<string | null>(null);
  const entries =
    mode === "registered"
      ? events
          .filter((e) => e.currency === currency)
          .map((e) => ({ ...e, label: e.description }))
      : items
          .filter(
            (i) =>
              ["expense", "benefit"].includes(i.purpose) &&
              i.currency === currency &&
              i.planned_cents !== null &&
              BigInt(i.planned_cents) > 0n,
          )
          .map((i) => ({
            id: i.id,
            label: i.label,
            kind: "expense" as const,
            amount_cents: (-BigInt(i.planned_cents!)).toString(),
            category_id: i.category_id,
            category_name:
              categories.find((c) => c.id === i.category_id)?.name ?? null,
          }));
  const { slices, adjustments, total } = categorySpending(entries);
  let cursor = 0;
  const gradient = slices
    .map((r, i) => {
      const start = cursor;
      cursor += Number((r.cents * 1000000n) / total) / 10000;
      return `${colors[i % colors.length]} ${start}% ${i === slices.length - 1 ? 100 : cursor}%`;
    })
    .join(",");
  const details = selected
    ? entries.filter(
        (e) =>
          (e.category_id ?? "uncategorized") === selected &&
          ["expense", "fee", "card_purchase", "refund"].includes(e.kind),
      )
    : [];
  return (
    <section
      className="family-spending"
      aria-labelledby="family-spending-title"
    >
      <h2 id="family-spending-title">Gastos por categoria</h2>
      <div
        className="category-chart-tabs"
        role="group"
        aria-label="Origem dos valores do gráfico"
      >
        <button
          type="button"
          aria-pressed={mode === "registered"}
          onClick={() => {
            setMode("registered");
            setSelected(null);
          }}
        >
          Registrados
        </button>
        <button
          type="button"
          aria-pressed={mode === "planned"}
          onClick={() => {
            setMode("planned");
            setSelected(null);
          }}
        >
          Planejados
        </button>
      </div>
      <p className="family-footnote">
        {mode === "registered"
          ? "Consumo registrado no histórico deste mês. Prévias bancárias ficam de fora."
          : "Despesas previstas no plano do mês; não representam gastos realizados."}{" "}
        Transferências, câmbio, reservas e pagamentos de fatura ficam fora.
      </p>
      {hidden ? (
        <p className="family-group-empty">
          Mostre os valores para ver o gráfico.
        </p>
      ) : !slices.length ? (
        <p className="family-group-empty">
          {mode === "registered"
            ? "Ainda não há despesas registradas neste mês. Você pode consultar o planejamento acima."
            : "Ainda não há despesas planejadas com valor definido."}
        </p>
      ) : (
        <div className="family-pie-layout">
          <div
            className="family-pie"
            role="img"
            aria-label={`Gráfico unificado de gastos ${mode === "registered" ? "registrados" : "planejados"} por categoria; valores na legenda.`}
            style={{ background: `conic-gradient(${gradient})` }}
          >
            <span>
              <small>
                {mode === "registered" ? "Registrados" : "Planejados"}
              </small>
              <strong>{formatted(total.toString(), currency)}</strong>
            </span>
          </div>
          <ul className="family-pie-legend">
            {slices.map((r, i) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="category-legend-button"
                  aria-pressed={selected === r.id}
                  onClick={() => setSelected(selected === r.id ? null : r.id)}
                >
                  <span
                    className="category-symbol"
                    style={{ color: colors[i % colors.length] }}
                  >
                    <CategoryIcon name={r.name} />
                  </span>
                  <span>
                    {r.name}
                    <small>
                      {(
                        Number((r.cents * 1000n + total / 2n) / total) / 10
                      ).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}
                      %
                    </small>
                  </span>
                  <strong>{formatted(r.cents.toString(), currency)}</strong>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!hidden && selected && (
        <div className="category-details">
          <h3>{slices.find((s) => s.id === selected)?.name ?? "Categoria"}</h3>
          <ul>
            {details.map((e) => (
              <li key={e.id}>
                <span>{e.label}</span>
                <strong>
                  {formatted(
                    (BigInt(e.amount_cents) < 0n
                      ? -BigInt(e.amount_cents)
                      : BigInt(e.amount_cents)
                    ).toString(),
                    currency,
                  )}
                  {e.kind === "refund" ? " · estorno" : ""}
                </strong>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setSelected(null)}>
            Fechar detalhes da categoria
          </button>
        </div>
      )}
      {!hidden && adjustments.length > 0 && (
        <p className="family-footnote">
          Há reembolsos maiores que os gastos de algumas categorias. Eles ficam
          fora das fatias e continuam descontados das saídas.
        </p>
      )}
      <p className="family-footnote">
        Toque no ícone ou nome de uma categoria para ver seus itens.
        Planejamento e histórico ficam separados, sem somar uma conta duas
        vezes. Valores ainda sem categoria aparecem como “Sem categoria”.
      </p>
    </section>
  );
}
