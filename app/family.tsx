"use client";
import {
  HomeLayout,
  HomeBlock,
  PreferencesPanel,
  AppOverview,
} from "./family-personalization";
import {
  defaultPreferences,
  accentForeground,
  type Preferences,
  type HomeCardId,
} from "../src/domain/preferences";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  type FormEvent,
} from "react";
import type { readState } from "../src/server/state.ts";
import type { readRoutine, MonthlyItem } from "../src/server/routine.ts";
import { formatted, plainMoney, brDate } from "../src/domain/format.ts";
import { cents, type Currency } from "../src/domain/finance.ts";
import { planGroup } from "../src/domain/dashboard.ts";
import { CategoryPicker, CategoryIcon } from "./family-categories";
import { CardsPanel } from "./family-cards";
import type { readCards } from "../src/server/cards.ts";
import { paymentReminders } from "../src/domain/reminders.ts";
import { SpendingPie } from "./family-dashboard";
import { MovementsPanel } from "./family-movements";
import { HeaderAvatar } from "./header-avatar";
import { NotificationsPanel } from "./family-notifications";
import { ProfileCard } from "./profile-card";
import { QuickActions } from "./family-quick-actions";
import { BankPanel } from "./family-banks";
import { InstallApp } from "./mobile";
import { FamilyAdministration } from "./family-administration";
import { FamilyIcon, FuturePanel, HelpPanel } from "./family-extras";
import { useAsyncAction } from "./use-async-action";

type Data = {
  cards: Awaited<ReturnType<typeof readCards>>;
  state: Awaited<ReturnType<typeof readState>>;
  routine: Awaited<ReturnType<typeof readRoutine>>;
};
type User = {
  name: string;
  role: string;
  email: string;
  administrator?: boolean;
};
type Item = Data["routine"]["items"][number];
type Tab = "month" | "movements" | "future" | "help" | "panorama" | "us";
const tabs: [Tab, string, string][] = [
  ["month", "Mês", "month"],
  ["movements", "Movimentos", "movements"],
  ["future", "Futuro", "future"],
  ["help", "Judite", "help"],
];
const purposes: Record<string, string> = {
  expense: "Conta a pagar",
  income: "Entrada prevista",
  card: "Fatura",
  saving: "Reserva ou objetivo",
  benefit: "Pago com benefício",
};
function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
}
async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || "Não foi possível salvar. Tente novamente.");
  return value;
}
function values(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget));
}
function moveMonth(month: string, n: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function money(n: string | null, currency: string = "BRL", hidden = false) {
  return hidden
    ? "••••"
    : n === null
      ? "A definir"
      : formatted(n, currency as Currency);
}
export default function FamilyApp() {
  const [auth, setAuth] = useState<{
    configured: boolean;
    hosted?: boolean;
    user: User | null;
  } | null>(null);
  const [data, setData] = useState<Data | null>(null),
    [month, setMonth] = useState(() => today().slice(0, 7));
  const currency: Currency = "BRL";
  const [tab, setTab] = useState<Tab>("month"),
    [hidden, setHidden] = useState(false);
  const { busy, error, notice, setError, run } = useAsyncAction({
    fallbackError: "Não foi possível salvar.",
  });
  const [modal, setModal] = useState<
      "item" | "movement" | "check" | "entry" | "period" | null
    >(null),
    [selected, setSelected] = useState<Item | null>(null),
    [filter, setFilter] = useState("all");
  const [bankReviewAccount, setBankReviewAccount] = useState("");
  const [profilePanel, setProfilePanel] = useState<string | null>(null);
  const toggleProfile = (panel: string) =>
    setProfilePanel((current) => (current === panel ? null : panel));
  const [itemPurpose, setItemPurpose] = useState("expense");
  const [newCostType, setNewCostType] = useState("auto");
  const [movementKind, setMovementKind] = useState("expense");
  const [members, setMembers] = useState<User[]>([]);
  const [personal, setPersonal] = useState<{
      email: string;
      preferences: Preferences;
    } | null>(null),
    [tourReplay, setTourReplay] = useState(false),
    [homeEditing, setHomeEditing] = useState(false);
  const preferences =
    auth?.user && personal?.email === auth.user.email
      ? personal.preferences
      : null;
  useEffect(() => {
    const p = preferences ?? defaultPreferences;
    document.documentElement.dataset.theme = p.theme;
    document.documentElement.style.setProperty("--family-accent", p.accent);
    document.documentElement.style.setProperty(
      "--family-on-accent",
      accentForeground(p.accent),
    );
  }, [preferences]);
  function updatePreferences(p: Preferences) {
    if (auth?.user) setPersonal({ email: auth.user.email, preferences: p });
  }
  const dialog = useRef<HTMLDialogElement>(null),
    requestSequence = useRef(0),
    operationId = useRef("");
  useEffect(() => {
    const params = new URLSearchParams(location.search),
      view = params.get("view");
    if (
      ["month", "movements", "future", "help", "panorama", "us"].includes(
        view || "",
      )
    )
      setTab(view as Tab);
    if (
      view === "us" &&
      ["#family-banks", "#bank-onboarding", "#bank-review-title"].includes(
        location.hash,
      )
    )
      setProfilePanel("banks");
    if (/^\d{4}-\d{2}$/.test(params.get("month") || ""))
      setMonth(params.get("month")!);
  }, []);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("view", tab);
    url.searchParams.set("month", month);
    history.replaceState(null, "", url);
  }, [tab, month]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  const load = useCallback(async () => {
    const seq = ++requestSequence.current;
    const status = await api<NonNullable<typeof auth>>("auth/status");
    if (seq !== requestSequence.current) return;
    setAuth(status);
    if (status.user) {
      const [next, prefs] = await Promise.all([
        api<Data>("family/month?" + new URLSearchParams({ month, currency })),
        api<Preferences>("profile/preferences"),
      ]);
      if (seq === requestSequence.current) {
        setData(next);
        setPersonal((prior) =>
          prior?.email === status.user!.email &&
          prior.preferences.revision >= prefs.revision &&
          (!prefs.onboarding_done || prior.preferences.onboarding_done)
            ? prior
            : { email: status.user!.email, preferences: prefs },
        );
      }
    } else {
      setData(null);
      setPersonal(null);
      setTourReplay(false);
    }
  }, [month, currency]);
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    return () => {
      requestSequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (!auth?.user || auth.user.role === "reader") return;
    let ended = false;
    const read = async () => {
      for (let i = 0; i < 5 && !ended; i++) {
        const result = await api<{ checked: number; failed: number }>(
          "banks/read-due",
          {},
        ).catch(() => null);
        if (!result || (!result.checked && !result.failed)) break;
        if (result.checked && !ended) {
          await load().catch(() => {});
          window.dispatchEvent(new Event("family-banks-updated"));
        }
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), 30 * 60 * 1000);
    return () => {
      ended = true;
      window.clearInterval(timer);
    };
  }, [auth?.user?.email, auth?.user?.role, load]);
  function work(
    action: () => Promise<void>,
    message = "Salvo para vocês dois.",
  ) {
    return run(action, message);
  }
  function open(
    kind: "item" | "movement" | "check" | "entry" | "period",
    item: Item | null = null,
    initialKind = "expense",
  ) {
    if (kind === "movement") setMovementKind(initialKind);
    if (kind === "item") {
      setItemPurpose(item?.purpose ?? initialKind);
      setNewCostType("auto");
    }
    setSelected(item);
    setModal(kind);
    setError("");
    operationId.current = crypto.randomUUID();
  }
  function navigate(next: Tab) {
    if (next !== "month") setHomeEditing(false);
    setTab(next);
    setError("");
    window.scrollTo({ top: 0 });
  }

  useEffect(() => {
    if (tab !== "us" || !auth?.user) return;
    let ended = false;
    void api<{ members: User[] }>("members")
      .then((m) => {
        if (!ended) setMembers(m.members);
      })
      .catch((e) => {
        if (!ended) setError(e.message);
      });
    return () => {
      ended = true;
    };
  }, [tab, auth?.user?.email]);
  const banner = (
    <>
      {error && (
        <p className="family-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="family-notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
  if (!auth)
    return (
      <main className="family-login">
        <span className="family-logo" aria-hidden="true">
          <img src="/icons/icon-192-v3.png" width="64" height="64" alt="" />
        </span>
        <h1>Abrindo nosso espaço…</h1>
        {banner}
      </main>
    );
  if (!auth.user)
    return (
      <main className="family-login">
        <span className="family-logo" aria-hidden="true">
          <img src="/icons/icon-192-v3.png" width="64" height="64" alt="" />
        </span>
        <p className="eyebrow">ENTRE NÓS</p>
        <h1>
          O mês fica mais leve
          <br />
          quando é nosso.
        </h1>
        <p>Um lugar para as contas, os planos e a vida de vocês.</p>
        <form
          onSubmit={(e) => {
            const v = values(e);
            void work(async () => {
              await api(auth.configured ? "auth/login" : "auth/setup", v);
              await load();
            }, "");
          }}
        >
          {!auth.configured && (
            <>
              <label>
                Seu nome
                <input name="name" autoComplete="given-name" required />
              </label>
              <input type="hidden" name="familyName" value="Nossa família" />
              {auth.hosted && (
                <label>
                  Código de configuração
                  <input
                    name="setupToken"
                    type="password"
                    autoComplete="off"
                    required
                  />
                </label>
              )}
            </>
          )}
          <label>
            E-mail
            <input
              name="email"
              type="email"
              autoComplete="username"
              spellCheck={false}
              required
            />
          </label>
          <label>
            Senha
            <input
              name="password"
              type="password"
              autoComplete={
                auth.configured ? "current-password" : "new-password"
              }
              minLength={12}
              maxLength={128}
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            {busy ? "Entrando…" : "Entrar no nosso espaço"}
          </button>
        </form>
        {banner}
        <p className="fine">Acesso privado de vocês dois.</p>
      </main>
    );
  if (!data)
    return (
      <main className="family-login">
        <h1>Preparando nosso mês…</h1>
        {banner}
        <button onClick={() => void load()}>Tentar novamente</button>
      </main>
    );
  const periodReady =
    data.state.month === month + "-01" && data.state.currency === currency;
  const items = periodReady
      ? data.routine.items.filter((i) => i.currency === currency)
      : [],
    expenses = items.filter((i) => i.purpose !== "income"),
    income = items.filter((i) => i.purpose === "income");
  const total = (list: MonthlyItem[], paid = false) =>
    list.reduce(
      (n, i) =>
        n +
        BigInt(
          (paid
            ? i.status === "open"
              ? "0"
              : (i.paid_cents ?? (i.status === "done" ? i.planned_cents : "0"))
            : i.planned_cents) ?? "0",
        ),
      0n,
    );
  const planned = total(expenses),
    incoming = total(income),
    received = total(income, true);
  const bills = expenses.filter((i) => i.purpose !== "saving");
  const unpaid = bills.filter((i) => i.status !== "done");
  const current = today();
  const reminders = paymentReminders(items, current);
  const overdue = unpaid.filter(
    (i) => i.due_date && i.due_date < current,
  ).length;
  const remaining = unpaid.reduce((sum, i) => {
    const balance =
      BigInt(i.planned_cents ?? "0") - BigInt(i.paid_cents ?? "0");
    return sum + (balance > 0n ? balance : 0n);
  }, 0n);
  const groups = [
    {
      id: "income",
      title: "Entradas",
      description: "O que esperamos receber",
      action: "Planejar entrada",
    },
    {
      id: "fixed",
      title: "Custos fixos",
      description: "Compromissos recorrentes da casa",
      action: "Planejar custo fixo",
    },
    {
      id: "variable",
      title: "Custos variáveis",
      description: "Gastos do dia a dia e valores que variam",
      action: "Planejar custo variável",
    },
    {
      id: "saving",
      title: "Reservas e objetivos",
      description: "Dinheiro guardado, separado dos gastos",
      action: "Planejar reserva",
    },
  ];
  const monthTitle = new Intl.DateTimeFormat("pt-BR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(month + "-01T12:00:00Z"));
  const periodControl = (
    <button
      className="family-period-chip"
      aria-label={`Escolher mês: ${monthTitle}`}
      onClick={() => open("period")}
    >
      <span>{monthTitle}</span>
      <span aria-hidden="true">⌄</span>
    </button>
  );
  const extras = data.state.events.filter((e) => e.sources.length === 0);
  const unresolved = data.state.bankRows.filter((r) => !r.recorded).length;
  const extraExpense = extras
    .filter((e) => ["expense", "fee", "card_purchase"].includes(e.kind))
    .reduce((n, e) => n - BigInt(e.amount_cents), 0n);
  const extraIncome = extras
    .filter((e) => ["income", "yield"].includes(e.kind))
    .reduce((n, e) => n + BigInt(e.amount_cents), 0n);
  return (
    <div className={`family-app${tab === "help" ? " is-chat" : ""}`}>
      <a className="skip-link" href="#family-content">
        Ir para o mês
      </a>
      <header className="family-header">
        <h1 className="sr-only">
          {tab === "month"
            ? "Nosso mês"
            : tab === "us"
              ? "Nosso espaço"
              : tab === "future"
                ? "Nosso futuro"
                : tab === "help"
                  ? "Judite"
                  : tab === "panorama"
                    ? "Panorama"
                    : "Movimentos"}
        </h1>
        <button
          className="family-icon"
          onClick={() => setHidden(!hidden)}
          aria-label={hidden ? "Mostrar valores" : "Ocultar valores"}
          aria-pressed={hidden}
        >
          <FamilyIcon name="eye" />
        </button>
        <button
          className="family-icon"
          data-tour="profile"
          aria-label="Nosso espaço e configurações"
          onClick={() => navigate("us")}
        >
          <HeaderAvatar
            key={auth.user.email + ":" + (preferences?.revision ?? 0)}
            hasPhoto={preferences?.has_photo ?? false}
            revision={preferences?.revision ?? 0}
          />
        </button>
      </header>
      <main id="family-content" className="family-main">
        {!["us", "month", "help"].includes(tab) && (
          <div className="family-period-context">{periodControl}</div>
        )}
        {banner}
        {!periodReady && (
          <div className="family-period-loading" role="status">
            <span>Carregando o mês selecionado…</span>
            {error && (
              <button
                onClick={() => void load().catch((e) => setError(e.message))}
              >
                Tentar novamente
              </button>
            )}
          </div>
        )}
        {tab === "month" && periodReady && (
          <>
            <section
              className="month-controls"
              aria-label="Mês e contas do planejamento"
            >
              <div className="month-control-bar" data-tour="month">
                <button
                  type="button"
                  aria-label="Mês anterior"
                  onClick={() => setMonth(moveMonth(month, -1))}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="month-control-title"
                  aria-label={`Escolher mês: ${monthTitle}`}
                  onClick={() => open("period")}
                >
                  <span>{monthTitle}</span>
                  <span aria-hidden="true">⌄</span>
                </button>
                <button
                  type="button"
                  aria-label="Próximo mês"
                  onClick={() => setMonth(moveMonth(month, 1))}
                >
                  ›
                </button>
              </div>
              <div
                className="month-plan-tabs"
                role="group"
                aria-label="Filtrar contas do plano"
              >
                {[
                  ["all", "Todas"],
                  ["open", "Em aberto"],
                  ["done", "Concluídas"],
                ].map(([value, label]) => (
                  <button
                    type="button"
                    key={value}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>
            <HomeLayout
              preferences={preferences ?? defaultPreferences}
              editing={homeEditing}
              onEditingChange={setHomeEditing}
              onSaved={updatePreferences}
            >
              <HomeBlock cardId="receipts">
                {data?.routine.receipts.map((r, index) => (
                  <aside className="bank-review" key={index}>
                    <strong>{r.label} · para o próximo mês</strong>
                    <p className="fine">
                      {r.received_date
                        ? "Crédito identificado em " +
                          brDate(r.received_date) +
                          " · " +
                          money(r.amount_cents, "BRL", hidden)
                        : "Recebimento previsto em " + brDate(r.expected_date)}
                      . Destinado ao planejamento de{" "}
                      {r.budget_month.slice(5, 7)}/{r.budget_month.slice(0, 4)}.
                    </p>
                    <p className="fine">{r.note}</p>
                  </aside>
                ))}
              </HomeBlock>
              <HomeBlock
                cardId="summary"
                caption={
                  !bills.length
                    ? "Vamos organizar o mês?"
                    : unpaid.length
                      ? `${unpaid.length} contas para pagar`
                      : "Contas do mês em dia"
                }
              >
                <section
                  className="family-month-summary"
                  aria-label="Resumo das contas do mês"
                >
                  <div className="family-summary-heading">
                    <span className="family-summary-kicker">
                      NOSSO PLANEJAMENTO
                    </span>
                  </div>
                  <h2>
                    {!bills.length
                      ? "Vamos organizar o mês?"
                      : unpaid.length
                        ? `Ainda ${unpaid.length === 1 ? "falta 1 conta para pagar" : `faltam ${unpaid.length} contas para pagar`}`
                        : "Contas do mês em dia"}
                  </h2>
                  <p>
                    {unpaid.length
                      ? `${money(remaining.toString(), currency, hidden)} em aberto${unpaid.some((i) => i.planned_cents === null) ? " · total parcial" : ""}`
                      : "Planejem juntos e acompanhem cada pagamento por aqui."}
                  </p>
                  {overdue > 0 && (
                    <span className="family-due-alert">
                      {overdue}{" "}
                      {overdue === 1
                        ? "conta com vencimento passado"
                        : "contas com vencimento passado"}
                    </span>
                  )}
                  <footer className="family-month-totals">
                    <span>
                      Entradas registradas{" "}
                      <strong>
                        {money(
                          data.state.summary.income_cents,
                          currency,
                          hidden,
                        )}
                      </strong>
                    </span>
                    <span>
                      Saídas registradas{" "}
                      <strong>
                        {money(
                          data.state.summary.expense_cents,
                          currency,
                          hidden,
                        )}
                      </strong>
                    </span>
                  </footer>
                </section>
              </HomeBlock>
              <HomeBlock cardId="alerts">
                <section
                  className="family-card payment-alerts"
                  aria-label="Alarmes e vencimentos"
                >
                  <div className="family-section">
                    <h2>Alarmes e vencimentos</h2>
                    <button
                      type="button"
                      onClick={() => {
                        setProfilePanel("notifications");
                        navigate("us");
                      }}
                    >
                      Configurar alarmes
                    </button>
                  </div>
                  <p className="fine">
                    Avisos no app e, com sua permissão, no iPhone. Nenhum
                    pagamento é feito automaticamente.
                  </p>
                  {data.cards
                    .filter(
                      (c) =>
                        c.manual_bill &&
                        !c.manual_bill.paid &&
                        BigInt(c.manual_bill.amount_cents) > 0n,
                    )
                    .map((c) => (
                      <a
                        className="payment-alert"
                        key={"manual-" + c.id}
                        href={"#card-" + c.local_account_id}
                      >
                        <span>
                          <strong>{c.name}</strong>
                          <small>
                            Fatura informada · vence{" "}
                            {brDate(c.manual_bill!.due_date)}
                          </small>
                        </span>
                        <span>
                          {money(c.manual_bill!.amount_cents, currency, hidden)}
                          <small>em aberto</small>
                        </span>
                      </a>
                    ))}
                  {data.cards
                    .filter((c) => c.projection && !c.projection.needs_review)
                    .map((c) => (
                      <button
                        type="button"
                        className="payment-alert"
                        key={"card-cycle-" + c.id}
                        onClick={() => {
                          setBankReviewAccount(c.local_account_id);
                          setProfilePanel("banks");
                          navigate("us");
                        }}
                      >
                        <span>
                          <strong>{c.name}</strong>
                          <small>
                            Conferir fatura · vencimento informado:{" "}
                            {brDate(c.projection!.due_date)}
                          </small>
                        </span>
                        <span>
                          {money(c.projection!.total_cents, currency, hidden)}
                          <small>estimativa</small>
                        </span>
                      </button>
                    ))}
                  {reminders.dated.slice(0, 3).map((r) => (
                    <button
                      type="button"
                      className={"payment-alert alert-" + r.urgency}
                      key={r.id}
                      onClick={() =>
                        open(
                          "item",
                          items.find((i) => i.id === r.id)!,
                        )
                      }
                    >
                      <span>
                        <strong>{r.label}</strong>
                        <small>
                          {r.urgency === "overdue"
                            ? "Em atraso"
                            : r.urgency === "today"
                              ? "Vence hoje"
                              : "Vence em " + brDate(r.due_date!)}
                        </small>
                      </span>
                      <span>{money(r.remaining_cents, currency, hidden)}</span>
                    </button>
                  ))}
                  {!reminders.dated.length && (
                    <p className="fine">
                      Nenhuma conta em aberto com vencimento definido neste mês.
                    </p>
                  )}
                  {!!reminders.missingDates.length && (
                    <details>
                      <summary>
                        {reminders.missingDates.length} conta(s) sem vencimento
                        — definir para receber alarmes
                      </summary>
                      {reminders.missingDates.map((r) => (
                        <button
                          type="button"
                          className="payment-alert"
                          key={r.id}
                          onClick={() =>
                            open(
                              "item",
                              items.find((i) => i.id === r.id)!,
                            )
                          }
                        >
                          {r.label}
                          <span>Definir data</span>
                        </button>
                      ))}
                    </details>
                  )}
                </section>
              </HomeBlock>
              <HomeBlock cardId="cards">
                <CardsPanel
                  month={month}
                  onRefresh={load}
                  reader={auth.user.role === "reader"}
                  cards={data.cards}
                  hidden={hidden}
                  onReview={(account) => {
                    setBankReviewAccount(account);
                    setProfilePanel("banks");
                    navigate("us");
                  }}
                />
              </HomeBlock>
              {groups.map((group) => {
                const groupItems = items.filter(
                  (i) => planGroup(i) === group.id,
                );
                const shown = groupItems.filter(
                  (i) =>
                    filter === "all" ||
                    (filter === "done"
                      ? i.status === "done"
                      : i.status !== "done"),
                );
                return (
                  <HomeBlock cardId={group.id as HomeCardId} key={group.id}>
                    <section
                      key={group.id}
                      className={`family-plan-group group-${group.id}`}
                      aria-label={group.title}
                    >
                      <div className="family-group-heading">
                        <div>
                          <h3>{group.title}</h3>
                          <p>{group.description}</p>
                        </div>
                        <strong>
                          {money(
                            total(groupItems).toString(),
                            currency,
                            hidden,
                          )}
                          <small>
                            previsto
                            {groupItems.some((i) => i.planned_cents === null)
                              ? " · parcial"
                              : ""}
                          </small>
                        </strong>
                      </div>
                      <div className="family-list">
                        {shown.map((i) => (
                          <article
                            key={i.id}
                            className={
                              "family-item " +
                              (i.status === "done" ? "is-done" : "")
                            }
                          >
                            <button
                              className="family-check"
                              disabled={busy || auth.user?.role === "reader"}
                              aria-label={
                                (i.status === "done"
                                  ? "Reabrir "
                                  : "Concluir ") + i.label
                              }
                              onClick={() => open("check", i)}
                            >
                              {i.status === "done"
                                ? "✓"
                                : i.status === "partial"
                                  ? "½"
                                  : i.purpose === "income"
                                    ? "↓"
                                    : "○"}
                            </button>
                            <button
                              className="family-item-body"
                              onClick={() => open("item", i)}
                            >
                              <strong>
                                <span className="plan-category-icon">
                                  <CategoryIcon
                                    name={
                                      data.state.categories.find(
                                        (c) => c.id === i.category_id,
                                      )?.name ?? i.label
                                    }
                                  />
                                </span>
                                {i.label}
                              </strong>
                              <span>
                                {i.status === "done"
                                  ? i.purpose === "income"
                                    ? "Recebido"
                                    : i.purpose === "saving"
                                      ? "Reservado"
                                      : "Pago"
                                  : i.status === "partial"
                                    ? i.purpose === "income"
                                      ? "Recebido em parte"
                                      : "Pago em parte"
                                    : i.due_date
                                      ? (i.due_date < current
                                          ? "Venceu em "
                                          : "Previsto para ") +
                                        brDate(i.due_date)
                                      : "Sem data definida"}
                                {i.purpose === "benefit" ? " · Benefício" : ""}
                                {i.funding && (
                                  <span className="income-funding">
                                    {i.funding.received_date
                                      ? "Crédito no banco em " +
                                        brDate(i.funding.received_date)
                                      : (i.funding.receipt_mode ===
                                        "business_window"
                                          ? "Janela aproximada até "
                                          : "Recebimento previsto em ") +
                                        brDate(i.funding.expected_date)}{" "}
                                    · financia este mês. {i.funding.note}
                                  </span>
                                )}
                              </span>
                            </button>
                            <strong className="family-amount">
                              {money(i.planned_cents, currency, hidden)}
                            </strong>
                          </article>
                        ))}
                        {!shown.length && (
                          <p className="family-group-empty">
                            {groupItems.length
                              ? "Nenhum item neste filtro."
                              : "Ainda não há itens planejados."}
                          </p>
                        )}
                      </div>
                      <button
                        className="family-plan-add"
                        aria-label={group.action}
                        disabled={busy || auth.user?.role === "reader"}
                        onClick={() => {
                          open(
                            "item",
                            null,
                            group.id === "income"
                              ? "income"
                              : group.id === "saving"
                                ? "saving"
                                : "expense",
                          );
                          setNewCostType(
                            group.id === "fixed" || group.id === "variable"
                              ? group.id
                              : "auto",
                          );
                        }}
                      >
                        ＋ {group.action}
                      </button>
                    </section>
                  </HomeBlock>
                );
              })}
              <HomeBlock cardId="categories">
                <SpendingPie
                  key={month + currency}
                  events={data.state.events}
                  currency={currency}
                  hidden={hidden}
                  items={items}
                  categories={data.state.categories}
                />
              </HomeBlock>
            </HomeLayout>
            <p className="family-footnote">
              Fixos e variáveis têm uma classificação sugerida pelo nome. Toque
              em uma conta para ajustar. Marcar como pago ou recebido atualiza o
              plano, sem duplicar os movimentos.
            </p>
            {!items.length && (
              <button
                disabled={busy || auth.user?.role === "reader"}
                onClick={() =>
                  void work(async () => {
                    await api("routine/copy", {
                      from: moveMonth(month, -1),
                      to: month,
                    });
                    await load();
                  }, "Planejamento copiado. Os pagamentos começam em aberto.")
                }
              >
                Usar planejamento do mês anterior
              </button>
            )}
            {items.some((i) => i.source_line_id) && (
              <p className="family-footnote">
                Preenchido com seu planejamento. As marcações “pago” da planilha
                foram preservadas; valores sem confirmação não foram tratados
                como pagamentos.{" "}
                {items.some((i) => i.derived)
                  ? "Este mês usa os valores reais como base do plano, conforme você pediu."
                  : ""}
              </p>
            )}
          </>
        )}
        {tab === "movements" && periodReady && (
          <MovementsPanel
            key={month}
            state={data.state}
            currency={currency}
            hidden={hidden}
            reader={auth.user.role === "reader"}
            onRecord={() => open("movement")}
          />
        )}
        {tab === "future" && periodReady && (
          <FuturePanel
            key={month + currency + data.state.summary.event_count}
            month={month}
            currency={currency}
            hidden={hidden}
            items={items}
            reader={auth.user.role === "reader"}
            plan={() => open("item")}
            record={(kind) => open("movement", null, kind)}
            panorama={() => navigate("panorama")}
          />
        )}
        <div className="family-chat-slot" hidden={tab !== "help"}>
          <HelpPanel
            month={today().slice(0, 7)}
            currency={currency}
            hidden={hidden}
            record={() => open("movement")}
            refresh={load}
            reader={auth.user.role === "reader"}
            active={tab === "help"}
          />
        </div>
        {tab === "panorama" && periodReady && (
          <>
            <section className="family-hero">
              <p>Plano e imprevistos</p>
              <h2>
                {money(
                  (incoming - planned - extraExpense + extraIncome).toString(),
                  currency,
                  hidden,
                )}
              </h2>
              <p>
                Entradas previstas menos compromissos, considerando também o que
                vocês registraram fora do plano.
              </p>
            </section>
            <section className="family-card">
              <h2>Entradas acompanhadas</h2>
              <p>
                Previsto: {money(incoming.toString(), currency, hidden)} ·
                Marcado como recebido:{" "}
                {money(received.toString(), currency, hidden)}
              </p>
            </section>
            <section className="family-card">
              <h2>Fora do plano</h2>
              <div className="family-two">
                <div>
                  <small>Gastos extras</small>
                  <strong>
                    {money(extraExpense.toString(), currency, hidden)}
                  </strong>
                </div>
                <div>
                  <small>Entradas extras</small>
                  <strong>
                    {money(extraIncome.toString(), currency, hidden)}
                  </strong>
                </div>
              </div>
            </section>
            <section className="family-card">
              <h2>O que o histórico confirma</h2>
              <div className="family-two">
                <div>
                  <small>Entradas registradas</small>
                  <strong>
                    {money(data.state.summary.income_cents, currency, hidden)}
                  </strong>
                </div>
                <div>
                  <small>Consumo registrado</small>
                  <strong>
                    {money(data.state.summary.expense_cents, currency, hidden)}
                  </strong>
                </div>
              </div>
              <p className="fine">
                Transferências próprias, reservas e câmbio ficam fora desses
                dois totais. As moedas são acompanhadas separadamente.
              </p>
            </section>
            <section className="family-card">
              <h2>Para conversar em casa</h2>
              {planned > incoming && (
                <p>
                  Os compromissos planejados superam as entradas previstas em{" "}
                  {money((planned - incoming).toString(), currency, hidden)}.
                  Vale escolher juntos o que ajustar.
                </p>
              )}
              <p>
                {
                  expenses.filter(
                    (i) =>
                      i.status !== "done" &&
                      i.due_date &&
                      i.due_date <= current,
                  ).length
                }{" "}
                contas em aberto já chegaram ao vencimento. Sem data definida,
                nenhum atraso é presumido.
              </p>
              {unresolved > 0 && (
                <p>
                  O histórico deste mês tem {unresolved} movimentos a
                  esclarecer. Por isso, os totais bancários ainda são parciais.
                </p>
              )}
              {!hidden &&
                data.state.insights
                  .filter((i) =>
                    ["income_currency", "spending"].includes(i.type),
                  )
                  .slice(0, 2)
                  .map((i) => (
                    <p key={i.type}>
                      <strong>{i.title}.</strong> {i.fact}
                    </p>
                  ))}
            </section>
            <section className="family-card">
              <h2>Nossas contas</h2>
              {data.state.accounts
                .filter((a) => a.currency === currency)
                .map((a) => (
                  <div className="family-account" key={a.id}>
                    <div>
                      <strong>{a.name}</strong>
                      <small>
                        {a.observed_date
                          ? "Último extrato: " + brDate(a.observed_date)
                          : "Saldo inicial não informado"}
                      </small>
                    </div>
                    <strong>
                      {money(
                        a.balance_cents ?? a.observed_balance_cents ?? null,
                        a.currency,
                        hidden,
                      )}
                    </strong>
                  </div>
                ))}
              <p className="fine">
                Saldos de extratos são referências históricas, não o saldo de
                hoje. Sem todos os movimentos classificados, o saldo calculado
                pode estar incompleto.
              </p>
            </section>
          </>
        )}
        {tab === "us" && periodReady && (
          <div className="profile-cards">
            {preferences && (
              <ProfileCard
                title="Meu perfil"
                description="Foto, cores e aparência do app"
                expanded={profilePanel === "appearance"}
                onToggle={() => toggleProfile("appearance")}
              >
                <PreferencesPanel
                  key={auth.user.email}
                  preferences={preferences}
                  onSaved={updatePreferences}
                  name={auth.user.name}
                  onTour={() => setTourReplay(true)}
                  onEditHome={() => {
                    navigate("month");
                    setHomeEditing(true);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              </ProfileCard>
            )}
            <ProfileCard
              title="Nosso casal"
              description="Quem compartilha este espaço com você"
              expanded={profilePanel === "couple"}
              onToggle={() => toggleProfile("couple")}
            >
              <section className="family-card">
                <h2>Um espaço para vocês dois</h2>
                {members.map((m) => (
                  <p key={m.email}>
                    <strong>{m.name}</strong>
                    <br />
                    {m.email}
                  </p>
                ))}
                {auth.user.role === "owner" && members.length === 1 && (
                  <details>
                    <summary>Adicionar minha esposa</summary>
                    <form
                      onSubmit={(e) => {
                        const v = values(e);
                        void work(async () => {
                          await api("members", { ...v, role: "editor" });
                          setMembers(
                            (await api<{ members: User[] }>("members")).members,
                          );
                        }, "Acesso individual criado.");
                      }}
                    >
                      <label>
                        Nome
                        <input
                          name="name"
                          autoComplete="name"
                          required
                          maxLength={120}
                        />
                      </label>
                      <label>
                        E-mail
                        <input
                          name="email"
                          type="email"
                          autoComplete="email"
                          required
                        />
                      </label>
                      <label>
                        Senha inicial
                        <input
                          name="password"
                          type="password"
                          minLength={12}
                          maxLength={128}
                          autoComplete="new-password"
                          required
                        />
                      </label>
                      <button disabled={busy}>Criar acesso dela</button>
                    </form>
                  </details>
                )}
              </section>
            </ProfileCard>
            {auth.user.administrator && (
              <ProfileCard
                title="Administrar famílias"
                description="Adicionar e consultar os casais convidados"
                expanded={profilePanel === "administration"}
                onToggle={() => toggleProfile("administration")}
              >
                <FamilyAdministration />
              </ProfileCard>
            )}
            <ProfileCard
              title="Bancos conectados"
              description="Conectar contas e conferir movimentos"
              expanded={profilePanel === "banks"}
              onToggle={() => toggleProfile("banks")}
            >
              <BankPanel
                initialAccount={bankReviewAccount}
                accounts={data.state.accounts}
                categories={data.state.categories}
                reader={auth.user.role === "reader"}
                hidden={hidden}
                refresh={load}
              />
            </ProfileCard>
            <ProfileCard
              title="Notificações"
              description="Lembretes e avisos nos seus aparelhos"
              expanded={profilePanel === "notifications"}
              onToggle={() => toggleProfile("notifications")}
            >
              <NotificationsPanel />
            </ProfileCard>
            <ProfileCard
              title="Privacidade e acesso"
              description="Proteção dos dados, senha e sair da conta"
              expanded={profilePanel === "privacy"}
              onToggle={() => toggleProfile("privacy")}
            >
              <section className="family-card">
                <h2>Privacidade</h2>
                <p>
                  Os documentos originais continuam no computador. Os registros
                  financeiros e as conversas ficam no banco privado. Cada acesso
                  vê apenas o próprio histórico de chat.
                </p>
                <p className="fine">
                  Marcar um compromisso como pago atualiza a lista do mês. Isso
                  não duplica um pagamento que já está no histórico.
                </p>
                <details>
                  <summary>Alterar minha senha</summary>
                  <form
                    onSubmit={(e) => {
                      const v = values(e);
                      void work(async () => {
                        await api("auth/password", v);
                      }, "Senha atualizada; outros acessos foram encerrados.");
                    }}
                  >
                    <label>
                      Senha atual
                      <input
                        name="current"
                        type="password"
                        autoComplete="current-password"
                        required
                      />
                    </label>
                    <label>
                      Nova senha
                      <input
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={128}
                        required
                      />
                    </label>
                    <button disabled={busy}>Salvar nova senha</button>
                  </form>
                </details>
                <button
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      await api("auth/logout", {});
                      setData(null);
                      await load();
                    }, "")
                  }
                >
                  Sair do nosso espaço
                </button>
              </section>
            </ProfileCard>
            <ProfileCard
              title="Instalar o app"
              description="Adicionar o Entre Nós ao seu aparelho"
              expanded={profilePanel === "install"}
              onToggle={() => toggleProfile("install")}
            >
              <InstallApp />
            </ProfileCard>
          </div>
        )}
      </main>
      {tab === "month" && periodReady && !homeEditing && !modal && (
        <QuickActions
          key={month}
          planning={month !== today().slice(0, 7)}
          reader={auth.user.role === "reader"}
          onIncome={() =>
            month === today().slice(0, 7)
              ? open("entry")
              : open("item", null, "income")
          }
          onExpense={() =>
            month === today().slice(0, 7)
              ? open("movement")
              : open("item", null, "expense")
          }
          onEdit={() => {
            setHomeEditing(true);
            window.scrollTo({ top: 0, behavior: "instant" });
          }}
        />
      )}
      {preferences && (
        <AppOverview
          key={auth.user.email}
          preferences={preferences}
          onSaved={updatePreferences}
          replay={tourReplay}
          onStart={() => {
            setHomeEditing(false);
            setTab("month");
          }}
          onClose={() => setTourReplay(false)}
        />
      )}
      <nav
        data-tour="navigation"
        className="family-nav"
        aria-label="Áreas da família"
      >
        {tabs.map(([id, label, icon]) => (
          <button
            key={id}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => navigate(id)}
          >
            <span aria-hidden="true">
              <FamilyIcon name={icon} />
            </span>
            {label}
          </button>
        ))}
      </nav>
      <dialog
        ref={dialog}
        className="family-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setModal(null);
        }}
        onClose={() => setModal(null)}
        aria-labelledby="family-dialog-title"
      >
        <div className="family-section">
          <h2 id="family-dialog-title">
            {modal === "period"
              ? "Escolher mês"
              : modal === "entry"
                ? "Adicionar entrada"
                : modal === "movement"
                  ? ["investment_buy", "investment_sell", "yield"].includes(
                      movementKind,
                    )
                    ? "Registrar investimento"
                    : "Registrar movimento"
                  : modal === "check"
                    ? "Atualizar compromisso"
                    : selected
                      ? "Ajustar nosso plano"
                      : "Planejar um compromisso"}
          </h2>
          <button
            aria-label="Fechar"
            disabled={busy}
            onClick={() => setModal(null)}
          >
            ✕
          </button>
        </div>
        {modal === "period" && (
          <div className="family-period-options">
            <div className="family-period-step">
              <button
                aria-label="Mês anterior"
                onClick={() => setMonth(moveMonth(month, -1))}
              >
                ‹
              </button>
              <strong>{monthTitle}</strong>
              <button
                aria-label="Próximo mês"
                onClick={() => setMonth(moveMonth(month, 1))}
              >
                ›
              </button>
            </div>
            <label>
              Ir para outro mês
              <input
                aria-label="Ir para outro mês"
                type="month"
                value={month}
                onInput={(e) => {
                  if (e.currentTarget.value) setMonth(e.currentTarget.value);
                }}
                onChange={(e) => {
                  if (e.target.value) setMonth(e.target.value);
                }}
              />
            </label>
            <button className="primary" onClick={() => setModal(null)}>
              Ver este mês
            </button>
            <button
              onClick={() => {
                setMonth(today().slice(0, 7));
                setModal(null);
              }}
            >
              Voltar ao mês atual
            </button>
          </div>
        )}
        {modal === "entry" && (
          <div className="family-entry-options">
            <p>O dinheiro já entrou ou ainda está previsto?</p>
            <button
              className="primary"
              onClick={() => open("movement", null, "income")}
            >
              Já recebi · registrar entrada
            </button>
            <button onClick={() => open("item", null, "income")}>
              Vou receber · planejar entrada
            </button>
            <p className="fine">
              Se a entrada já existe no extrato ou no plano, atualize o item
              existente para evitar duplicar.
            </p>
          </div>
        )}
        {modal === "item" && (
          <form
            key={selected?.id ?? "new"}
            onSubmit={(e) => {
              const v = values(e);
              void work(async () => {
                await api("routine/item", {
                  ...v,
                  ...(selected
                    ? { id: selected.id, version: selected.version }
                    : {}),
                  month,
                  currency: selected?.currency ?? currency,
                  category_id:
                    v.category_id === undefined
                      ? (selected?.category_id ?? null)
                      : v.category_id || null,
                  due_date: v.due_date || null,
                  cost_type:
                    ["expense", "card", "benefit"].includes(itemPurpose) &&
                    v.cost_type !== "auto"
                      ? v.cost_type
                      : null,
                });
                setModal(null);
                await load();
              });
            }}
          >
            <label>
              O que vamos planejar?
              <input
                name="label"
                defaultValue={selected?.label}
                required
                maxLength={180}
                placeholder={
                  itemPurpose === "income"
                    ? "Ex.: salário, trabalho extra…"
                    : "Ex.: energia de casa…"
                }
              />
            </label>
            <label>
              Tipo
              <select
                name="purpose"
                value={itemPurpose}
                onChange={(e) => setItemPurpose(e.target.value)}
                disabled={!!selected}
              >
                {Object.entries(purposes).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              {selected && (
                <input type="hidden" name="purpose" value={selected.purpose} />
              )}
            </label>
            {["expense", "card", "benefit"].includes(itemPurpose) && (
              <label>
                Como aparece no mês
                <select
                  name="cost_type"
                  defaultValue={selected?.cost_type ?? newCostType}
                >
                  <option value="auto">Sugerir pelo nome da conta</option>
                  <option value="fixed">
                    Custo fixo · compromisso recorrente
                  </option>
                  <option value="variable">
                    Custo variável · gasto que varia
                  </option>
                </select>
              </label>
            )}
            <label>
              Valor previsto ({selected?.currency ?? currency})
              <input
                name="amount"
                inputMode="decimal"
                defaultValue={
                  selected?.planned_cents
                    ? plainMoney(selected.planned_cents)
                    : ""
                }
                placeholder="0,00"
              />
            </label>
            <label>
              Vencimento (opcional)
              <input
                name="due_date"
                type="date"
                min={month + "-01"}
                max={moveMonth(month, 1) + "-01"}
                defaultValue={selected?.due_date ?? ""}
              />
            </label>
            {["expense", "benefit"].includes(
              selected?.purpose ?? itemPurpose,
            ) && (
              <CategoryPicker
                categories={data.state.categories}
                value={selected?.category_id}
              />
            )}
            <label>
              Observações
              <textarea
                name="notes"
                maxLength={1000}
                defaultValue={selected?.notes}
              />
            </label>
            {selected?.source_note && (
              <p className="fine">Na planilha: {selected.source_note}</p>
            )}
            {selected?.actual_reference_cents && (
              <p className="fine">
                Valor de referência da planilha:{" "}
                {money(
                  selected.actual_reference_cents,
                  selected.currency,
                  hidden,
                )}
                . Não gera um novo movimento.
              </p>
            )}
            <button
              className="primary"
              disabled={busy || auth.user?.role === "reader"}
            >
              {busy ? "Salvando…" : "Salvar no nosso mês"}
            </button>
          </form>
        )}
        {modal === "check" && selected && (
          <form
            key={selected.id}
            onSubmit={(e) => {
              const v = values(e);
              void work(async () => {
                await api("routine/check", {
                  ...v,
                  id: selected.id,
                  version: selected.version,
                  amount: v.amount || null,
                  date: v.date || null,
                  event_id: v.event_id || null,
                });
                setModal(null);
                await load();
              });
            }}
          >
            <p>
              <strong>{selected.label}</strong>
            </p>
            <label>
              Como está?
              <select
                name="status"
                defaultValue={selected.status === "done" ? "open" : "done"}
              >
                <option value="done">
                  {selected.purpose === "income"
                    ? "Recebido"
                    : "Pago / reservado"}
                </option>
                <option value="partial">
                  {selected.purpose === "income"
                    ? "Recebido em parte"
                    : "Pago parcialmente"}
                </option>
                <option value="open">Em aberto</option>
              </select>
            </label>
            <label>
              Valor realizado (opcional)
              <input
                name="amount"
                inputMode="decimal"
                defaultValue={
                  selected.paid_cents
                    ? plainMoney(selected.paid_cents)
                    : selected.planned_cents
                      ? plainMoney(selected.planned_cents)
                      : ""
                }
                placeholder="0,00"
              />
            </label>
            <label>
              Data (opcional)
              <input
                type="date"
                name="date"
                defaultValue={selected.paid_date ?? today()}
              />
            </label>
            {selected.candidates.length > 0 && (
              <label>
                Vincular a movimento já registrado (opcional)
                <select name="event_id" defaultValue={selected.event_id ?? ""}>
                  <option value="">Apenas atualizar a lista</option>
                  {selected.candidates.map((e) => (
                    <option key={e.id} value={e.id}>
                      {brDate(e.transaction_date)} ·{" "}
                      {e.description.slice(0, 75)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="fine">
              Atualiza o acompanhamento do mês sem repetir os movimentos
              bancários. Uma coincidência de valor é sugestão, não confirmação.
            </p>
            <button className="primary" disabled={busy}>
              {busy ? "Salvando…" : "Atualizar compromisso"}
            </button>
          </form>
        )}
        {modal === "movement" && (
          <MovementForm
            key={movementKind}
            initialKind={movementKind}
            accounts={data.state.accounts}
            categories={data.state.categories}
            currency={currency}
            busy={busy}
            submit={async (body) => {
              await work(async () => {
                await api("events", {
                  ...body,
                  request_id: operationId.current,
                });
                setModal(null);
                await load();
              });
            }}
          />
        )}
        {modal && error && (
          <p className="family-error" role="alert">
            {error}
          </p>
        )}
      </dialog>
    </div>
  );
}
function MovementForm({
  initialKind = "expense",
  accounts,
  categories,
  currency,
  busy,
  submit,
}: {
  initialKind?: string;
  accounts: Data["state"]["accounts"];
  categories: Data["state"]["categories"];
  currency: Currency;
  busy: boolean;
  submit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState(initialKind),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const account = accounts.find((a) => a.id === from),
    counter = accounts.find((a) => a.id === to),
    paired = [
      "transfer",
      "fx",
      "card_payment",
      "investment_buy",
      "investment_sell",
    ].includes(kind);
  return (
    <form
      onSubmit={(e) => {
        const v = values(e);
        let amount;
        try {
          amount = cents(String(v.amount));
        } catch {
          void submit({});
          return;
        }
        const negative = !["income", "investment_sell", "yield"].includes(kind);
        const signed = (negative ? -1n : 1n) * (amount < 0n ? -amount : amount);
        void submit({
          ...v,
          kind,
          amount: plainMoney(signed.toString()),
          category_id: paired ? null : v.category_id || null,
          counter_account_id: paired ? to : null,
          counter_currency: kind === "fx" ? counter?.currency : null,
          counter_amount: kind === "fx" ? v.counter_amount : null,
          related_event_id: null,
        });
      }}
    >
      <label>
        O que aconteceu?
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="expense">Gasto fora do plano</option>
          <option value="income">Entrada extra</option>
          <option value="transfer">Transferência entre nossas contas</option>
          <option value="card_payment">Pagamento de fatura</option>
          <option value="fx">Conversão de moeda</option>
          <option value="investment_buy">Aporte em investimento</option>
          <option value="investment_sell">Resgate de investimento</option>
          <option value="yield">Rendimento</option>
        </select>
      </label>
      <label>
        Descrição
        <input
          name="description"
          required
          maxLength={180}
          placeholder="Ex.: passeio em família…"
        />
      </label>
      <label>
        {kind === "investment_sell"
          ? "Conta que recebeu o resgate"
          : paired
            ? "Saiu de"
            : "Conta"}
        <select
          name="account_id"
          required
          value={from}
          onChange={(e) => {
            setFrom(e.target.value);
            setTo("");
          }}
        >
          <option value="">Escolher conta</option>
          {accounts
            .filter(
              (a) =>
                a.currency === currency &&
                (kind !== "card_payment" || a.kind !== "card"),
            )
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.currency}
              </option>
            ))}
        </select>
      </label>
      {paired && (
        <label>
          {kind === "investment_sell" ? "Investimento resgatado" : "Foi para"}
          <select
            name="counter_account_id"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            required
          >
            <option value="">Escolher destino</option>
            {accounts
              .filter(
                (a) =>
                  a.id !== from &&
                  (kind === "fx"
                    ? a.currency !== account?.currency
                    : a.currency === account?.currency) &&
                  (kind !== "card_payment" || a.kind === "card") &&
                  (!["investment_buy", "investment_sell"].includes(kind) ||
                    a.kind === "investment"),
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.currency}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        Valor {account?.currency ?? currency}
        <input
          name="amount"
          inputMode="decimal"
          pattern="[0-9.]+,[0-9]{2}"
          placeholder="0,00"
          required
        />
      </label>
      {kind === "fx" && (
        <label>
          Valor recebido em {counter?.currency ?? "outra moeda"}
          <input
            name="counter_amount"
            inputMode="decimal"
            pattern="[0-9.]+,[0-9]{2}"
            placeholder="0,00"
            required
          />
        </label>
      )}
      <label>
        Data
        <input name="date" type="date" required defaultValue={today()} />
      </label>
      {!paired && <CategoryPicker categories={categories} required />}
      {paired && (
        <p className="fine">
          Registra os dois lados uma única vez. Transferir ou converter seu
          dinheiro não cria renda nem consumo.
        </p>
      )}
      <button className="primary" disabled={busy}>
        {busy ? "Salvando…" : "Registrar para nós dois"}
      </button>
    </form>
  );
}
