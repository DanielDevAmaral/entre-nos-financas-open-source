"use client";
import { useEffect, useState } from "react";
import type { readInvestments } from "../src/server/future.ts";
import type { MonthlyItem } from "../src/server/routine.ts";
import { formatted, brDate } from "../src/domain/format.ts";
import type { Currency } from "../src/domain/finance.ts";

export function FamilyIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    month: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18m-12 5 2 2 4-4" />
      </>
    ),
    movements: <path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4" />,
    future: <path d="m3 17 6-6 4 3 8-10m-6 0h6v6M3 21h18" />,
    help: (
      <path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" />
    ),
    eye: (
      <>
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    us: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
      </>
    ),
  };
  return (
    <svg
      className="family-svg"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] ?? paths.help}
    </svg>
  );
}
export function ThemeControl() {
  const [theme, setTheme] = useState("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("entre-nos-theme-v1");
      if (saved && ["system", "light", "dark"].includes(saved)) setTheme(saved);
    } catch {}
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <label className="family-theme">
      Aparência
      <select
        aria-label="Aparência"
        value={theme}
        onChange={(e) => {
          const next = e.target.value;
          setTheme(next);
          try {
            localStorage.setItem("entre-nos-theme-v1", next);
          } catch {}
        }}
      >
        <option value="system">Do aparelho</option>
        <option value="light">Claro</option>
        <option value="dark">Escuro</option>
      </select>
    </label>
  );
}
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch("/api/" + url, { cache: "no-store", signal });
  if (!response.ok)
    throw new Error("Não foi possível carregar. Tente novamente.");
  return response.json();
}
type Investments = Awaited<ReturnType<typeof readInvestments>>;
export function FuturePanel({
  month,
  currency,
  hidden,
  items,
  plan,
  record,
  panorama,
  reader,
}: {
  month: string;
  currency: Currency;
  hidden: boolean;
  items: MonthlyItem[];
  plan: () => void;
  record: (kind: string) => void;
  panorama: () => void;
  reader: boolean;
}) {
  const [data, setData] = useState<Investments | null>(null),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    void read<Investments>("investments?month=" + month, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [month, retry]);
  const money = (n: string, c: string = currency) =>
    hidden ? "••••" : formatted(n, c as Currency);
  const goals = items.filter(
    (i) => i.purpose === "saving" && i.currency === currency,
  );
  return (
    <>
      <p className="family-intro">Pequenos passos para o que importa.</p>
      <section className="family-card">
        <div className="family-section">
          <h2>Investimentos</h2>
          <FamilyIcon name="future" />
        </div>
        <p className="fine">
          Referências históricas até o fim do mês selecionado. As moedas ficam
          separadas.
        </p>
        {error && (
          <p role="alert">
            {error}{" "}
            <button onClick={() => setRetry((n) => n + 1)}>
              Tentar novamente
            </button>
          </p>
        )}
        {!data && !error && <p role="status">Buscando investimentos…</p>}
        {data?.positions.map((a) => (
          <div className="family-position" key={a.id}>
            <strong>{a.name}</strong>
            <span className="family-position-value">
              {a.observed_cents !== null
                ? money(a.observed_cents, a.currency)
                : a.calculated_cents !== null
                  ? money(a.calculated_cents, a.currency)
                  : "Saldo a completar"}
            </span>
            <small>
              {a.observed_date
                ? `Extrato de ${brDate(a.observed_date)} · ${a.currency}`
                : a.calculated_cents !== null
                  ? `Valor calculado com os registros disponíveis · ${a.currency}`
                  : `${a.currency} · posição inicial não informada`}
            </small>
            {a.calculated_cents !== null && a.observed_cents !== null && (
              <small>
                Calculado pelos lançamentos:{" "}
                {money(a.calculated_cents, a.currency)} · pode ter lacunas
              </small>
            )}
          </div>
        ))}
        {data && !data.positions.length && (
          <p>
            Ainda não há conta de investimento registrada. As reservas
            planejadas aparecem abaixo.
          </p>
        )}
        <p className="fine">
          Não é cotação em tempo real. Sem posição e histórico completos, não
          estimamos rentabilidade nem somamos moedas diferentes.
        </p>
      </section>
      <section className="family-card">
        <h2>Movimentações de {month}</h2>
        {["investment_buy", "investment_sell", "yield"].map((kind) => {
          const row = data?.movements.find(
            (m) => m.kind === kind && m.currency === currency,
          );
          return (
            <div className="family-account" key={kind}>
              <span>
                {
                  {
                    investment_buy: "Aportes",
                    investment_sell: "Resgates",
                    yield: "Rendimentos registrados",
                  }[kind]
                }
              </span>
              <strong>{data ? money(row?.amount_cents ?? "0") : "…"}</strong>
            </div>
          );
        })}
        <p className="fine">
          Rendimentos aqui incluem registros desta natureza em todas as contas,
          e não representam a rentabilidade da carteira.
        </p>
        <details>
          <summary>Registrar aporte, resgate ou rendimento</summary>
          <div className="family-actions">
            {[
              ["investment_buy", "Aporte"],
              ["investment_sell", "Resgate"],
              ["yield", "Rendimento"],
            ].map(([kind, label]) => (
              <button key={kind} disabled={reader} onClick={() => record(kind)}>
                {label}
              </button>
            ))}
          </div>
          <p className="fine">
            A operação será registrada apenas após conferir conta, valor e data.
          </p>
        </details>
      </section>
      <div className="family-section">
        <h2>Nossas reservas do mês</h2>
        <button disabled={reader} onClick={plan}>
          Planejar
        </button>
      </div>
      {goals.map((g) => {
        const target = BigInt(g.planned_cents ?? "0"),
          paid = BigInt(
            g.paid_cents ??
              (g.status === "done" ? g.planned_cents : null) ??
              "0",
          );
        const progress = target > 0n ? Number((paid * 100n) / target) : 0;
        return (
          <section className="family-card" key={g.id}>
            <h3>{g.label}</h3>
            <div className="family-two">
              <div>
                <small>Planejado neste mês</small>
                <strong>
                  {g.planned_cents === null
                    ? "A definir"
                    : money(g.planned_cents)}
                </strong>
              </div>
              <div>
                <small>Marcado como reservado</small>
                <strong>{money(paid.toString())}</strong>
              </div>
            </div>
            {target > 0n && (
              <progress
                aria-label={`Progresso de ${g.label}`}
                value={Math.min(100, progress)}
                max={100}
              />
            )}
            <p className="fine">
              Acompanhe e ajuste em Mês. Esse compromisso não comprova o saldo
              acumulado da reserva.
            </p>
          </section>
        );
      })}
      {!goals.length && (
        <section className="family-card">
          <h3>Um espaço para os planos de vocês</h3>
          <p>
            Inclua um compromisso em Mês com o tipo “Reserva ou objetivo”. Assim
            vocês acompanham o valor combinado e o que já foi reservado.
          </p>
        </section>
      )}
      <button className="family-wide" onClick={panorama}>
        Ver panorama do mês e nossas contas
      </button>
    </>
  );
}
export { HelpPanel } from "./family-chat";
