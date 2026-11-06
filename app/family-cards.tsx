"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { readCards } from "../src/server/cards.ts";
import { cardOverview } from "../src/domain/card-overview";
import { formatted, brDate } from "../src/domain/format.ts";
type Cards = Awaited<ReturnType<typeof readCards>>;
export function CardsPanel({
  cards,
  month,
  hidden,
  onReview,
  onRefresh,
  reader = false,
}: {
  cards: Cards;
  month: string;
  hidden: boolean;
  onReview: (account: string) => void;
  onRefresh: () => Promise<void>;
  reader?: boolean;
}) {
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const overview = cardOverview(cards);
  const revealedHash = useRef("");
  useEffect(() => {
    let frame = 0;
    const reveal = () => {
      if (!location.hash.startsWith("#card-")) revealedHash.current = "";
      if (revealedHash.current === location.hash) return;
      const card = cards.find(
        (c) => location.hash === "#card-" + c.local_account_id,
      );
      if (card) {
        revealedHash.current = location.hash;
        setExpandedCard(card.id);
        frame = requestAnimationFrame(() =>
          document
            .getElementById("card-" + card.local_account_id)
            ?.scrollIntoView({ block: "start", behavior: "instant" }),
        );
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => {
      window.removeEventListener("hashchange", reveal);
      cancelAnimationFrame(frame);
    };
  }, [cards]);
  const money = (v: string | null) =>
    hidden ? "••••" : v === null ? "Não informado" : formatted(v, "BRL");
  if (!cards.length) return null;
  return (
    <section
      className="family-card credit-overview"
      aria-label="Compras e faturas do cartão"
    >
      <h2>Cartões do mês</h2>
      <div className="credit-total">
        <small>
          {overview.unknown
            ? "Total conhecido do mês"
            : "Total das faturas do mês"}
        </small>
        <strong>
          {overview.unknown === cards.length
            ? "A conferir"
            : money(overview.total_cents)}
        </strong>
      </div>
      <div
        className="credit-distribution"
        role="img"
        aria-label={
          hidden
            ? "Valores ocultos"
            : "Distribuição das faturas por cartão; valores na lista abaixo"
        }
      >
        {!hidden &&
          overview.rows
            .filter((r) => r.share > 0)
            .map((r) => (
              <span
                key={r.id}
                className={"card-color-" + (overview.rows.indexOf(r) % 5)}
                style={{ width: r.share + "%" }}
              />
            ))}
      </div>
      <p className="fine">
        {overview.hasEstimates ? "Inclui estimativas. " : ""}
        {overview.unknown
          ? `${overview.unknown} cartão(ões) com valor a conferir. `
          : ""}
        Faturas e compras não são somadas duas vezes.
      </p>
      {cards.map((c) => (
        <details
          key={c.id}
          id={"card-" + c.local_account_id}
          className="credit-account"
          open={expandedCard === c.id}
        >
          <summary
            className="credit-bank-summary"
            onClick={(event) => {
              event.preventDefault();
              setExpandedCard((old) => (old === c.id ? null : c.id));
            }}
          >
            <span
              className={"credit-bank-dot card-color-" + (cards.indexOf(c) % 5)}
              aria-hidden="true"
            />
            <span>
              <strong>
                {c.name}
                {c.last_four ? " · " + c.last_four : ""}
              </strong>
              <small>
                {overview.rows.find((r) => r.id === c.id)!.source}
                {overview.rows.find((r) => r.id === c.id)!.due_date
                  ? " · " +
                    brDate(overview.rows.find((r) => r.id === c.id)!.due_date!)
                  : ""}
              </small>
            </span>
            <strong>
              {overview.rows.find((r) => r.id === c.id)!.amount_cents === null
                ? "—"
                : money(overview.rows.find((r) => r.id === c.id)!.amount_cents)}
            </strong>
          </summary>
          <div className="credit-bank-detail">
            {!c.connected && (
              <p className="fine">
                Acompanhamento manual. A integração não disponibiliza este
                cartão. Informe os valores consultados no banco; eles ficam
                separados das compras registradas.
              </p>
            )}
            <dl className="credit-stats">
              <div>
                <dt>Limite total</dt>
                <dd>
                  {money(
                    c.connected ? c.credit_limit_cents : c.manual_limit_cents,
                  )}
                </dd>
              </div>
              <div>
                <dt>Disponível no cartão</dt>
                <dd>{money(c.available_credit_cents)}</dd>
              </div>
              <div>
                <dt>Limite comprometido</dt>
                <dd>{money(c.committed_credit_cents)}</dd>
              </div>
            </dl>
            <p className="fine">
              Limite de crédito não é saldo da família nem entrada de dinheiro.
              O limite comprometido pode incluir parcelas futuras e não
              representa a fatura do mês.
            </p>
            {!c.connected && (
              <>
                {c.manual_bill && (
                  <div className="credit-bill">
                    <div>
                      <strong>Fatura informada por vocês</strong>
                      <small>
                        Vencimento: {brDate(c.manual_bill.due_date)} ·{" "}
                        {c.manual_bill.paid ? "Marcada como paga" : "Em aberto"}
                      </small>
                    </div>
                    <strong>{money(c.manual_bill.amount_cents)}</strong>
                    <small>
                      Conta a pagar, sem adicionar despesa ao histórico ou ao
                      gráfico. O valor da fatura não determina o limite
                      disponível.
                    </small>
                  </div>
                )}
                <ManualCardForm
                  key={c.id + month}
                  card={c}
                  month={month}
                  reader={reader}
                  onRefresh={onRefresh}
                />
              </>
            )}
            {c.credit_limits_review && (
              <p className="fine">
                Os limites retornados precisam de conferência no banco; não
                estimamos o limite comprometido.
              </p>
            )}
            {c.projection && (
              <div className="credit-bill">
                <div>
                  <strong>
                    Estimativa para {brDate(c.projection.due_date)}
                  </strong>
                  <small>
                    Compras de {brDate(c.projection.start_date)} a{" "}
                    {brDate(c.projection.close_date)} · ciclo informado por
                    vocês.
                  </small>
                </div>
                <strong>{money(c.projection.total_cents)}</strong>
                <small>
                  {c.projection.purchase_count} compra(s),{" "}
                  {c.projection.bank_pending_count} ainda pendente(s) no banco.
                  Não é a fatura oficial nem inclui compras que não chegaram à
                  integração. Pagamentos e duplicidades ficam fora desta soma.
                </small>
                {c.projection.closing_day_count > 0 && (
                  <small>
                    Compras no dia do fechamento precisam de conferência: o
                    banco pode lançá-las no ciclo seguinte.
                  </small>
                )}
              </div>
            )}
            {c.connected && (
              <CycleForm
                accountId={c.local_account_id}
                cycle={c.cycle}
                reader={reader}
                onRefresh={onRefresh}
              />
            )}
            {c.bills.map((b) => (
              <div className="credit-bill" key={b.id}>
                <div>
                  <strong>Fatura com vencimento em {brDate(b.due_date)}</strong>
                  <small>
                    {b.close_date
                      ? "Fechamento informado: " + brDate(b.close_date)
                      : "Fechamento não informado"}
                  </small>
                </div>
                <strong>
                  {b.needs_review ? "Conferir valor" : money(b.total_cents)}
                </strong>
                {b.needs_review && (
                  <small>
                    O provedor retornou um valor que precisa de conferência no
                    banco. Ele foi preservado como evidência, sem arredondar nem
                    somar aos totais.
                  </small>
                )}
                <small>
                  Valor informado pelo banco; pagamento precisa de conciliação.{" "}
                  {b.assigned_count} compra(s) vinculada(s) a esta fatura.
                </small>
              </div>
            ))}
            {c.connected && !c.bills.length && (
              <p className="fine">
                {c.credit_due_date
                  ? (c.projection && c.credit_due_date !== c.projection.due_date
                      ? "Último vencimento retornado pelo banco (outro ciclo): "
                      : "Vencimento informado pelo cartão: ") +
                    brDate(c.credit_due_date) +
                    ". "
                  : ""}
                Valor atual consultado: {money(c.balance_cents)}. Esse valor é
                uma posição do cartão, não uma fatura fechada do mês
                selecionado.
              </p>
            )}
            {c.bills_read_ok === false && (
              <p className="fine">
                A consulta detalhada de faturas não ficou disponível nesta
                leitura. Os dados anteriores foram preservados.
              </p>
            )}
            <dl className="credit-stats">
              <div>
                <dt>Compras registradas</dt>
                <dd>{money(c.registered_cents)}</dd>
              </div>
              <div>
                <dt>Compras para conferir</dt>
                <dd>{money(c.preview_cents)}</dd>
              </div>
              <div>
                <dt>Aguardando o banco</dt>
                <dd>{money(c.bank_pending_cents)}</dd>
              </div>
            </dl>
            {(c.history_match_cents !== "0" || c.duplicate_cents !== "0") && (
              <p className="fine">
                Coincidências com o histórico: {money(c.history_match_cents)}.
                Possíveis duplicidades: {money(c.duplicate_cents)}. Esses
                valores ficam fora da prévia para evitar somar a mesma compra
                novamente; confira os vínculos.
              </p>
            )}
            {c.unassigned_cents !== "0" && (
              <p className="fine">
                Compras recentes sem mês de fatura confirmado:{" "}
                <strong>{money(c.unassigned_cents)}</strong>. Elas aparecem
                abaixo pela data da compra e não foram atribuídas à fatura deste
                mês por suposição.
              </p>
            )}
            {!!c.payments.length && (
              <p className="fine">
                {c.payments.length} pagamento(s) do cartão identificado(s) no
                período. Pagamento de fatura quita a dívida e não é uma nova
                despesa.
              </p>
            )}
            <details>
              <summary>
                Ver compras e pagamentos (
                {c.purchases.length + c.payments.length})
              </summary>
              <ul className="credit-purchases">
                {[...c.purchases, ...c.payments].map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>{r.description}</strong>
                      <small>
                        {brDate(r.transaction_date)} ·{" "}
                        {r.changed || r.missing
                          ? "Evidência alterada: revisar"
                          : r.event_id
                            ? "Já registrado"
                            : r.provider_status === "POSTED"
                              ? "Conferir antes de registrar"
                              : "Pendente no banco"}
                        {r.card_meta.installment_number &&
                        r.card_meta.total_installments
                          ? ` · Parcela ${r.card_meta.installment_number}/${r.card_meta.total_installments}`
                          : ""}
                      </small>
                    </div>
                    <span>{money(r.amount_cents)}</span>
                  </li>
                ))}
              </ul>
            </details>
            <p className="fine">
              Compras sem vínculo com uma fatura são mostradas pela data da
              operação. Com ciclo informado, indicamos uma estimativa separada
              da fatura oficial. A parcela é contada pelo valor do mês, sem
              multiplicar pelo número de parcelas.
            </p>
            {c.connected && (
              <button
                type="button"
                onClick={() => onReview(c.local_account_id)}
              >
                Conferir movimentos deste cartão
              </button>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}

function CycleForm({
  accountId,
  cycle,
  reader,
  onRefresh,
}: {
  accountId: string;
  cycle: Cards[number]["cycle"];
  reader: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/cards/cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: accountId,
          close_date: data.get("close_date"),
          due_date: data.get("due_date"),
        }),
      });
      const result = await r.json();
      if (!r.ok)
        throw new Error(result.error || "Não foi possível salvar o ciclo.");
      await onRefresh();
      setMessage("Ciclo salvo. As estimativas são separadas do histórico.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Não foi possível salvar.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>
        {cycle
          ? `Ciclo informado: fecha dia ${cycle.closing_day} · vence dia ${cycle.due_day}`
          : "Informar fechamento e vencimento"}
      </summary>
      {!reader && (
        <form onSubmit={save} className="card-cycle-form">
          <label>
            Próximo fechamento
            <input
              type="date"
              name="close_date"
              required
              defaultValue={cycle?.effective_close_date}
            />
          </label>
          <label>
            Vencimento dessa fatura
            <input
              type="date"
              name="due_date"
              required
              defaultValue={cycle?.effective_due_date}
            />
          </label>
          <p className="fine">
            Usamos esses dias para os próximos meses. Datas específicas do
            banco, quando disponíveis, continuam separadas. Não ajustamos
            feriados automaticamente.
          </p>
          <button disabled={busy}>
            {busy ? "Salvando…" : "Salvar ciclo do cartão"}
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </details>
  );
}

function ManualCardForm({
  card,
  month,
  reader,
  onRefresh,
}: {
  card: Cards[number];
  month: string;
  reader: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const value = (v: string | null | undefined) =>
    v == null
      ? ""
      : (BigInt(v) / 100n).toString() +
        "," +
        (BigInt(v) % 100n).toString().padStart(2, "0");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/cards/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account_id: card.local_account_id,
          month,
          limit: data.get("limit"),
          amount: data.get("amount"),
          due_date: data.get("due_date"),
          paid: data.get("paid") === "on",
        }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "Não foi possível salvar.");
      await onRefresh();
      setMessage(
        "Salvo. Nenhuma compra ou pagamento foi lançado no histórico.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }
  if (reader) return null;
  return (
    <details>
      <summary>
        {card.manual_bill
          ? "Editar limite e fatura"
          : "Informar limite e fatura"}
      </summary>
      <form className="card-cycle-form" onSubmit={save}>
        <p className="fine">
          Fatura com vencimento em {month.slice(5)}/{month.slice(0, 4)}. Ao
          salvar novamente, atualizamos a mesma fatura deste mês.
        </p>
        <label>
          Limite total (R$)
          <input
            name="limit"
            inputMode="decimal"
            placeholder="Ex.: 5.000,00"
            defaultValue={value(card.manual_limit_cents)}
          />
        </label>
        <label>
          Valor da fatura (R$)
          <input
            name="amount"
            inputMode="decimal"
            placeholder="Ex.: 850,00"
            defaultValue={value(card.manual_bill?.amount_cents)}
          />
        </label>
        <label>
          Vencimento da fatura
          <input
            name="due_date"
            type="date"
            min={month + "-01"}
            max={new Date(
              Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0),
            )
              .toISOString()
              .slice(0, 10)}
            defaultValue={card.manual_bill?.due_date ?? ""}
          />
        </label>
        <label className="manual-card-paid">
          <input
            name="paid"
            type="checkbox"
            defaultChecked={card.manual_bill?.paid ?? false}
          />
          Esta fatura já foi paga
        </label>
        <p className="fine">
          Marcar como paga apenas encerra o lembrete. Não movimenta contas nem
          cria uma segunda despesa. Informe as compras separadamente quando
          quiser detalhar categorias.
        </p>
        <button disabled={busy}>
          {busy ? "Salvando…" : "Salvar limite e fatura"}
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
