"use client";
import { useMemo, useState } from "react";
import type { readState } from "../src/server/state.ts";
import { formatted, brDate } from "../src/domain/format.ts";
import type { Currency } from "../src/domain/finance.ts";
import {
  movementGroup,
  movementTotals,
  visibleMovements,
  type Movement,
  type MovementFilter,
} from "../src/domain/movements.ts";
import { CategoryIcon } from "./family-categories";
import { FamilyIcon } from "./family-extras";

const filters: [MovementFilter, string][] = [
  ["all", "Todos"],
  ["income", "Entradas"],
  ["expense", "Gastos"],
  ["transfer", "Entre contas"],
  ["card", "Cartão"],
  ["review", "A conferir"],
];
const labels: Record<string, string> = {
  income: "Entrada",
  expense: "Gasto",
  transfer: "Entre nossas contas",
  fx: "Câmbio",
  card_purchase: "Compra no crédito",
  card_payment: "Pagamento de fatura",
  fee: "Tarifa",
  investment_buy: "Investimento",
  investment_sell: "Resgate",
  yield: "Rendimento",
  refund: "Reembolso",
};
type State = Awaited<ReturnType<typeof readState>>;
export function MovementsPanel({
  state,
  currency,
  hidden,
  reader,
  onRecord,
}: {
  state: State;
  currency: Currency;
  hidden: boolean;
  reader: boolean;
  onRecord: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MovementFilter>("all");
  const [account, setAccount] = useState("");
  const [limit, setLimit] = useState(40);
  const rows = useMemo<Movement[]>(
    () => [
      ...state.events.map((e) => ({
        id: "event:" + e.id,
        date: e.transaction_date,
        description: e.description,
        account: e.account_name,
        category: e.category_name,
        amount: e.amount_cents,
        kind: e.kind,
        review: false,
        duplicate: false,
      })),
      ...state.bankRows
        .filter((r) => !r.recorded)
        .map((r) => ({
          id: "bank:" + r.id,
          date: r.transaction_date,
          description: r.description,
          account: r.account_name,
          category: r.category_name,
          amount: r.amount_cents,
          kind: r.event_kind,
          review: true,
          duplicate: r.duplicate_hint,
        })),
    ],
    [state.events, state.bankRows],
  );
  const totals = useMemo(() => movementTotals(rows), [rows]);
  const filtered = useMemo(
    () => visibleMovements(rows, query, filter, account),
    [rows, query, filter, account],
  );
  const accounts = useMemo(
    () => [...new Set(rows.map((r) => r.account))].sort(),
    [rows],
  );
  const money = (amount: string) =>
    hidden ? "••••" : formatted(amount, currency);
  const groups = new Map<string, Movement[]>();
  for (const row of filtered.slice(0, limit))
    groups.set(row.date, [...(groups.get(row.date) ?? []), row]);
  return (
    <div className="movements-panel">
      <section
        className="movement-overview"
        aria-label="Resumo dos movimentos confirmados"
      >
        <div>
          <span
            className="movement-symbol"
            data-tone="income"
            aria-hidden="true"
          >
            ↙
          </span>
          <small>Entradas</small>
          <strong>{money(totals.income)}</strong>
        </div>
        <div>
          <span
            className="movement-symbol"
            data-tone="expense"
            aria-hidden="true"
          >
            ↗
          </span>
          <small>Gastos</small>
          <strong>{money(totals.expense)}</strong>
        </div>
        <p>
          Totais confirmados do mês. Transferências e pagamentos de fatura não
          são novos gastos; movimentos a conferir ficam fora dos totais.
        </p>
      </section>
      {totals.review > 0 && (
        <aside className="movement-review">
          <span>
            <strong>{totals.review} a conferir</strong>
            <small>Guardados para revisão, sem confirmar lançamentos.</small>
          </span>
          <button
            type="button"
            onClick={() => {
              setFilter("review");
              setLimit(40);
            }}
          >
            Ver
          </button>
        </aside>
      )}
      <section
        className="movement-tools"
        aria-label="Buscar e filtrar movimentos"
      >
        <div className="movement-search-row">
          <label>
            <span className="sr-only">Buscar movimentos</span>
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(40);
              }}
              placeholder="Buscar descrição, conta ou categoria"
            />
          </label>
          <button
            type="button"
            className="primary movement-add"
            disabled={reader}
            onClick={onRecord}
            aria-label="Registrar movimento"
          >
            ＋
          </button>
        </div>
        <div
          className="movement-chips"
          role="group"
          aria-label="Tipo de movimento"
        >
          {filters.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setLimit(40);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <details className="movement-account-filter">
          <summary>Filtrar por conta{account ? " · " + account : ""}</summary>
          <label>
            Conta
            <select
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setLimit(40);
              }}
            >
              <option value="">Todas as contas</option>
              {accounts.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          </label>
        </details>
      </section>
      <div className="movement-history-heading">
        <h2>Histórico do mês</h2>
        <span>
          {filtered.length} {filtered.length === 1 ? "movimento" : "movimentos"}
        </span>
      </div>
      {filtered.length === 0 && (
        <section className="family-card movement-empty">
          <FamilyIcon name="movements" />
          <h3>Nenhum movimento por aqui</h3>
          <p>
            {rows.length
              ? "Tente outra busca ou retire os filtros."
              : "Os registros deste mês vão aparecer aqui."}
          </p>
          {rows.length > 0 && (
            <button
              onClick={() => {
                setQuery("");
                setAccount("");
                setFilter("all");
              }}
            >
              Limpar filtros
            </button>
          )}
        </section>
      )}
      {[...groups].map(([date, entries]) => (
        <section
          className="movement-day"
          key={date}
          aria-label={"Movimentos de " + brDate(date)}
        >
          <h3>
            {new Intl.DateTimeFormat("pt-BR", {
              day: "numeric",
              month: "long",
              timeZone: "UTC",
            }).format(new Date(date + "T12:00:00Z"))}
          </h3>
          <div className="movement-day-list">
            {entries.map((row) => {
              const type = movementGroup(row);
              const neutral = [
                "transfer",
                "fx",
                "card_payment",
                "investment_buy",
                "investment_sell",
              ].includes(row.kind ?? "");
              const amount = BigInt(row.amount);
              return (
                <details className="movement-entry" key={row.id}>
                  <summary>
                    <span
                      className="movement-symbol"
                      data-tone={
                        row.review
                          ? "review"
                          : neutral
                            ? "neutral"
                            : amount > 0n
                              ? "income"
                              : "expense"
                      }
                    >
                      {type === "transfer" ? (
                        <FamilyIcon name="movements" />
                      ) : row.review ? (
                        <span aria-hidden="true">?</span>
                      ) : row.category ? (
                        <CategoryIcon name={row.category} />
                      ) : (
                        <span aria-hidden="true">
                          {neutral ? "↔" : amount > 0n ? "↙" : "↗"}
                        </span>
                      )}
                    </span>
                    <span className="movement-entry-name">
                      <strong>{row.description}</strong>
                      <small>{row.account}</small>
                      {row.review && (
                        <em>
                          {row.duplicate
                            ? "Possível repetição · a conferir"
                            : "A conferir"}
                        </em>
                      )}
                    </span>
                    <strong
                      className="movement-amount"
                      data-tone={
                        row.review || neutral
                          ? "neutral"
                          : amount > 0n
                            ? "income"
                            : "expense"
                      }
                    >
                      {money(row.amount)}
                    </strong>
                  </summary>
                  <dl className="movement-entry-detail">
                    <div>
                      <dt>Tipo</dt>
                      <dd>
                        {row.review
                          ? "Finalidade a confirmar"
                          : (labels[row.kind ?? ""] ?? "Movimento")}
                      </dd>
                    </div>
                    <div>
                      <dt>Categoria</dt>
                      <dd>{row.category ?? "Sem categoria"}</dd>
                    </div>
                    <div>
                      <dt>Data</dt>
                      <dd>{brDate(row.date)}</dd>
                    </div>
                    <div>
                      <dt>Situação</dt>
                      <dd>
                        {row.review
                          ? "Em revisão · fora dos totais"
                          : "Confirmado"}
                      </dd>
                    </div>
                  </dl>
                </details>
              );
            })}
          </div>
        </section>
      ))}
      {filtered.length > limit && (
        <button
          className="movement-more"
          onClick={() => setLimit((value) => value + 40)}
        >
          Ver mais {Math.min(40, filtered.length - limit)} movimentos
        </button>
      )}
      <p className="family-footnote">
        Toque em um movimento para ver os detalhes. Os dois lados de
        transferências podem aparecer nas contas de origem e destino; quando
        vinculados, representam uma única operação.
      </p>
    </div>
  );
}
