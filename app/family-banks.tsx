"use client";
import { useEffect, useState, type FormEvent } from "react";
import { reviewGroups, type ReviewGroup } from "../src/domain/bank-analysis.ts";
import type { readBanks, renewBank } from "../src/server/banks.ts";
import { pluggyItemId, bankSetupStage } from "../src/domain/bank-onboarding.ts";
import { formatted, brDate } from "../src/domain/format.ts";

type Renewal = Awaited<ReturnType<typeof renewBank>>;
type Banks = Awaited<ReturnType<typeof readBanks>>;
type LocalAccount = {
  id: string;
  name: string;
  currency: string;
  kind: string;
};
type Category = { id: string; name: string };
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error || "Não foi possível concluir. Tente novamente.",
    );
  return data;
}
function fields(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget));
}
export function BankPanel({
  accounts,
  categories,
  reader,
  hidden,
  refresh,
  initialAccount = "",
}: {
  accounts: LocalAccount[];
  categories: Category[];
  reader: boolean;
  hidden: boolean;
  refresh: () => Promise<void>;
  initialAccount?: string;
}) {
  const [data, setData] = useState<Banks | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [offset, setOffset] = useState(0),
    [group, setGroup] = useState(""),
    [account, setAccount] = useState(initialAccount),
    [selected, setSelected] = useState<string | null>(null),
    [guideStep, setGuideStep] = useState<number | null>(null);
  const load = async (page = offset, filter = group) => {
    const result = await api<Banks>(
      "banks?offset=" +
        page +
        "&group=" +
        encodeURIComponent(filter) +
        "&account=" +
        encodeURIComponent(account),
    );
    setData(result);
    setOffset(page);
  };
  useEffect(() => {
    let ended = false;
    const update = () =>
      void api<Banks>(
        "banks?offset=" +
          offset +
          "&group=" +
          encodeURIComponent(group) +
          "&account=" +
          encodeURIComponent(account),
      )
        .then((r) => {
          if (!ended) setData(r);
        })
        .catch((e) => {
          if (!ended) setError(e.message);
        });
    update();
    window.addEventListener("family-banks-updated", update);
    return () => {
      ended = true;
      window.removeEventListener("family-banks-updated", update);
    };
  }, [offset, group, account]);
  async function work(
    action: () => Promise<unknown>,
    message: string,
    financial = false,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await load();
      if (financial) await refresh();
      setNotice(message);
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tente novamente.");
    } finally {
      setBusy(false);
    }
  }
  const step = guideStep ?? (data ? bankSetupStage(data) : 1);
  const ownConnections =
    data?.connections.filter((c) => c.own && c.enabled) ?? [];
  const ownAccounts =
    data?.accounts.filter(
      (a) =>
        a.currency === "BRL" &&
        ownConnections.some((c) => c.id === a.connection_id),
    ) ?? [];
  const unmapped = ownAccounts.filter((a) => !a.local_account_id);
  const money = (value: string | null) =>
    hidden
      ? "••••"
      : value === null
        ? "Não informado"
        : formatted(value, "BRL");
  return (
    <section
      className="family-card family-banks"
      id="family-banks"
      aria-labelledby="family-banks-title"
    >
      <h2 id="family-banks-title">Bancos conectados</h2>
      <p>
        Leitura das contas de vocês, sem pagar, transferir ou movimentar
        dinheiro no banco.
      </p>
      {error && (
        <p role="alert" className="family-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="family-notice">
          {notice}
        </p>
      )}
      {!data ? (
        <button
          disabled={busy}
          onClick={() => void load().catch((e) => setError(e.message))}
        >
          Carregar conexões
        </button>
      ) : (
        <>
          {!data.storageReady && (
            <p className="family-footnote">
              A conexão bancária ainda não foi habilitada nesta instalação. Peça
              ao administrador para ativar a proteção das credenciais. Nenhuma
              senha de banco é pedida aqui.
            </p>
          )}
          {!reader && (
            <section
              id="bank-onboarding"
              className="bank-onboarding"
              aria-labelledby="bank-setup-title"
            >
              <h3 id="bank-setup-title">Conectar meus bancos</h3>
              <p className="fine">
                Cada pessoa faz este passo a passo no próprio perfil. Seus
                movimentos ficam apenas na sua família no Entre Nós; o outro
                casal não tem acesso. A Pluggy processa os dados que você
                autorizar.
              </p>
              <nav aria-label="Etapas da conexão bancária">
                <ol className="bank-steps">
                  {[
                    "Autorizar",
                    "Proteger acesso",
                    "Adicionar banco",
                    "Vincular contas",
                    "Conferir",
                  ].map((label, index) => (
                    <li key={label}>
                      <button
                        type="button"
                        aria-current={step === index + 1 ? "step" : undefined}
                        disabled={busy}
                        onClick={() => setGuideStep(index + 1)}
                      >
                        <span aria-hidden="true">{index + 1}</span>
                        {label}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
              <div className="bank-step-content" key={step}>
                <h4 tabIndex={-1}>
                  Etapa {step} de 5 ·{" "}
                  {
                    [
                      "Autorize suas contas",
                      "Proteja seu acesso",
                      "Adicione um banco seu",
                      "Escolha as contas correspondentes",
                      "Leia e confira os movimentos",
                    ][step - 1]
                  }
                </h4>
                {step === 1 && (
                  <>
                    <p>
                      Entre no Meu Pluggy com seu próprio acesso e conecte seus
                      bancos e cartões. Seu parceiro ou parceira fará o mesmo no
                      perfil dele ou dela.
                    </p>
                    <p>
                      Confira os dados solicitados e o prazo de autorização na
                      tela do banco. Nunca informe senha bancária no Entre Nós.
                    </p>
                    <a
                      className="bank-external"
                      href="https://meu.pluggy.ai"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir Meu Pluggy ↗
                    </a>
                    <p className="fine">
                      Usamos somente consultas: não fazemos pagamentos ou
                      transferências. As condições e a frequência de atualização
                      dependem do plano da Pluggy e do banco.
                    </p>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() => setGuideStep(2)}
                    >
                      Já autorizei meus bancos · continuar
                    </button>
                  </>
                )}
                {step === 2 && (
                  <>
                    <p>
                      Entre no painel da Pluggy com o mesmo acesso do Meu Pluggy. Abra{" "}
                      <strong>Applications → sua aplicação</strong> e copie o
                      Client ID e o Client Secret. Use as credenciais do seu
                      próprio acesso.
                    </p>
                    <a
                      className="bank-external"
                      href="https://dashboard.pluggy.ai"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir painel da Pluggy ↗
                    </a>
                    <p className="fine">
                      Se você já salvou seu acesso aqui, pode continuar. Gerar
                      um novo Client Secret pode invalidar o anterior; não é
                      necessário gerar outro a cada banco.
                    </p>
                    {!reader && (
                      <details className="bank-setup" open>
                        <summary>
                          {data.hasCredentials
                            ? "Atualizar meu acesso à API"
                            : "Configurar meu acesso à API"}
                        </summary>
                        <p className="fine">
                          Credenciais da API da Pluggy. Nunca informe senha
                          bancária. Elas serão cifradas e não poderão ser vistas
                          pelo outro titular.
                        </p>
                        <form
                          autoComplete="off"
                          onSubmit={(e) => {
                            const v = fields(e),
                              form = e.currentTarget;
                            void work(async () => {
                              await api("banks/credentials", {
                                clientId: v.clientId,
                                clientSecret: v.clientSecret,
                                consent: v.consent === "on",
                              });
                              form.reset();
                              setGuideStep(3);
                            }, "Seu acesso foi protegido. Agora adicione o itemId de cada banco.");
                          }}
                        >
                          <label>
                            Client ID
                            <input
                              name="clientId"
                              autoComplete="off"
                              required
                              minLength={8}
                              maxLength={300}
                            />
                          </label>
                          <label>
                            Client Secret
                            <input
                              name="clientSecret"
                              type="password"
                              autoComplete="off"
                              required
                              minLength={8}
                              maxLength={500}
                            />
                          </label>
                          <label className="bank-consent">
                            <input name="consent" type="checkbox" required />
                            Autorizo consultar minhas contas e compartilhar os
                            movimentos com esta família no Entre Nós.
                          </label>
                          <button
                            className="primary"
                            disabled={busy || !data.storageReady}
                          >
                            Proteger meu acesso
                          </button>
                        </form>
                      </details>
                    )}
                    {data.hasCredentials && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setGuideStep(3)}
                      >
                        Meu acesso já está salvo · continuar
                      </button>
                    )}
                  </>
                )}
                {step === 3 && (
                  <>
                    <p>
                      No painel da Pluggy, abra{" "}
                      <strong>
                        Applications → sua aplicação → Demo → Connect Account
                      </strong>
                      . Escolha <strong>MeuPluggy</strong> e selecione um dos
                      bancos já autorizados.
                    </p>
                    <p>
                      Abra a conexão criada e copie o <strong>itemId</strong>,
                      ou o link completo dessa tela. Repita esta etapa para cada
                      banco.
                    </p>
                    <a
                      className="bank-external"
                      href="https://meu.pluggy.ai/api-guide"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Ver guia oficial com as telas ↗
                    </a>
                    <p className="fine">
                      Seu parceiro já conectou o mesmo banco? Confira o titular
                      nas conexões abaixo. Não conecte novamente a mesma conta.
                      Para renovar uma autorização, use “Renovar” na conexão
                      existente.
                    </p>
                    {!data.hasCredentials && (
                      <p role="status">
                        Primeiro proteja seu acesso na etapa 2.
                      </p>
                    )}
                    {data.hasCredentials && !reader && (
                      <details className="bank-setup" open>
                        <summary>Identificar meu banco</summary>
                        <form
                          onSubmit={(e) => {
                            const v = fields(e),
                              form = e.currentTarget;
                            void work(async () => {
                              await api("banks/connect", {
                                item_id: pluggyItemId(String(v.item_id)),
                                label: v.label,
                                start_date: v.start_date,
                                consent: v.consent === "on",
                              });
                              form.reset();
                              setGuideStep(4);
                            }, "Conexão identificada, reutilizando o vínculo se já existia. Vincule as contas antes de ler os movimentos.");
                          }}
                        >
                          <label>
                            Nome para identificar
                            <input
                              name="label"
                              required
                              maxLength={120}
                              placeholder="Ex.: meu Nubank…"
                            />
                          </label>
                          <label>
                            itemId ou link da conexão no painel Pluggy
                            <input
                              name="item_id"
                              required
                              autoComplete="off"
                              spellCheck={false}
                              maxLength={2048}
                            />
                          </label>
                          <label>
                            Começar a conferir por
                            <input
                              name="start_date"
                              type="date"
                              required
                              defaultValue={
                                new Date()
                                  .toLocaleDateString("sv-SE", {
                                    timeZone: "America/Sao_Paulo",
                                  })
                                  .slice(0, 7) + "-01"
                              }
                            />
                          </label>
                          <label className="bank-consent">
                            <input name="consent" type="checkbox" required />
                            Sou titular desta conexão e autorizei a leitura pelo
                            Meu Pluggy.
                          </label>
                          <button
                            className="primary"
                            disabled={busy || !data.storageReady}
                          >
                            Adicionar banco
                          </button>
                        </form>
                      </details>
                    )}
                  </>
                )}
                {step === 4 && (
                  <>
                    <p>
                      Na lista abaixo, escolha a conta do Entre Nós
                      correspondente a cada conta ou cartão do banco. Reutilize
                      as contas que já têm histórico. Crie uma nova apenas
                      quando ela ainda não existir.
                    </p>
                    <p className="fine">
                      Vincular uma conta não altera o saldo inicial nem confirma
                      movimentos. Uma conta já vinculada não pode ser vinculada
                      outra vez.
                    </p>
                    {unmapped.length > 0 ? (
                      <p role="status">
                        Faltam {unmapped.length} contas ou cartões seus para
                        vincular.
                      </p>
                    ) : (
                      <p role="status">
                        {ownConnections.length
                          ? ownAccounts.length
                            ? "Suas contas disponíveis em reais estão vinculadas."
                            : "Esta conexão ainda não retornou contas em reais. Confira a autorização no Meu Pluggy."
                          : "Adicione um banco na etapa 3 para continuar."}
                      </p>
                    )}
                    <ul className="bank-guide-links">
                      {ownConnections.map((c) => (
                        <li key={c.id}>
                          <a href={"#bank-connection-" + c.id}>
                            {c.label} · {c.owner_label}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <button
                      type="button"
                      className="primary"
                      disabled={
                        busy || !ownAccounts.length || unmapped.length > 0
                      }
                      onClick={() => setGuideStep(5)}
                    >
                      Contas vinculadas · continuar
                    </button>
                  </>
                )}
                {step === 5 && (
                  <>
                    <p>
                      Em cada conexão abaixo, toque em{" "}
                      <strong>Ler atualização disponível</strong>. Os movimentos
                      vão para a prévia, sem entrar nos totais do mês.
                    </p>
                    <p>
                      Confira primeiro as possíveis duplicidades com seu
                      histórico e extratos. Transferências entre suas contas e
                      pagamentos de fatura precisam da conta de destino; não são
                      uma nova despesa.
                    </p>
                    <ul className="bank-guide-links">
                      {ownConnections.map((c) => (
                        <li key={c.id}>
                          <a href={"#bank-connection-" + c.id}>
                            {c.label} ·{" "}
                            {c.last_read_at
                              ? "Já teve leitura"
                              : "Aguardando primeira leitura"}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <a className="bank-external" href="#bank-review-title">
                      Ir para movimentos para conferir ↓
                    </a>
                    <p className="fine">
                      Somente uma decisão explícita na revisão registra um
                      lançamento. As leituras seguintes reutilizam os
                      identificadores do banco; coincidências com outros bancos
                      e documentos continuam sinalizadas para revisão.
                    </p>
                  </>
                )}
              </div>
              <details className="bank-help">
                <summary>Preciso de ajuda</summary>
                <p>
                  <strong>Não achei o itemId:</strong> abra a conexão criada em
                  Demo no painel da Pluggy e copie o link que contém itemId.
                  Neste fluxo pessoal, precisamos do itemId de cada conexão; não
                  descobrimos seus bancos automaticamente.
                </p>
                <p>
                  <strong>Apareceu o banco direto:</strong> volte à escolha do
                  conector e selecione MeuPluggy para usar a autorização já
                  feita no Meu Pluggy.
                </p>
                <p>
                  <strong>A autorização venceu:</strong> renove no Meu Pluggy ou
                  no banco e use “Renovar” na conexão existente aqui. Assim
                  preservamos o vínculo e o histórico.
                </p>
                <p>
                  <strong>Quero parar:</strong> “Pausar leitura” interrompe
                  nossas consultas. Para revogar o compartilhamento, use o Meu
                  Pluggy ou o banco. Os registros anteriores permanecem no app.
                </p>
              </details>
            </section>
          )}
          {!data.connections.length && (
            <p className="fine">
              Nenhum banco conectado ainda. Os documentos e lançamentos
              anteriores continuam preservados.
            </p>
          )}
          {data.connections.map((c) => (
            <article
              className="bank-connection"
              key={c.id}
              id={"bank-connection-" + c.id}
            >
              <div className="family-section">
                <div>
                  <h3>{c.label}</h3>
                  <small>
                    {c.owner_label} ·{" "}
                    {c.enabled ? "Leitura ativa" : "Leitura pausada"}
                  </small>
                </div>
              </div>
              <p className="fine">
                {c.last_read_at
                  ? "Última leitura: " +
                    new Date(c.last_read_at).toLocaleString("pt-BR")
                  : "Aguardando primeira leitura"}{" "}
                · Desde {brDate(c.start_date)}
              </p>
              {c.provider_updated_at && (
                <p className="fine">
                  Atualização informada pelo banco:{" "}
                  {new Date(c.provider_updated_at).toLocaleString("pt-BR")}
                </p>
              )}
              {c.consent_expires_at && (
                <p className="fine">
                  Autorização até{" "}
                  {new Date(c.consent_expires_at).toLocaleDateString("pt-BR")}
                </p>
              )}
              {c.error_code && (
                <p className="family-error">
                  A leitura precisa de atenção. Confira a autorização no Meu
                  Pluggy e tente novamente. Seus registros foram preservados.
                </p>
              )}
              {data.accounts
                .filter((a) => a.connection_id === c.id)
                .map((a) => (
                  <div className="bank-account" key={a.id}>
                    <strong>
                      {a.label}
                      {a.last_four ? " · final " + a.last_four : ""}
                    </strong>
                    {a.currency === "BRL" ? (
                      <p className="fine">
                        {a.account_type === "CREDIT"
                          ? "Valor informado pelo cartão"
                          : "Saldo consultado"}
                        : {money(a.balance_cents)} · Não altera a abertura nem o
                        planejamento.
                      </p>
                    ) : (
                      <p className="fine">
                        Referência em {a.currency}. Movimentos fora de BRL não
                        serão importados.
                      </p>
                    )}
                    {a.local_account_id ? (
                      <p className="fine">
                        Vinculada a{" "}
                        {accounts.find(
                          (local) => local.id === a.local_account_id,
                        )?.name ?? "uma conta do app"}
                        .
                      </p>
                    ) : (
                      c.own &&
                      !reader &&
                      a.currency === "BRL" && (
                        <form
                          onSubmit={(e) => {
                            const v = fields(e);
                            void work(
                              () =>
                                api("banks/map", {
                                  id: a.id,
                                  account_id:
                                    v.account_id === "__new__"
                                      ? null
                                      : v.account_id,
                                  ...(v.account_id === "__new__"
                                    ? { name: v.name }
                                    : {}),
                                }),
                              "Conta vinculada. Leia os movimentos disponíveis.",
                              true,
                            );
                          }}
                        >
                          <label>
                            Conta correspondente no Entre Nós
                            <select name="account_id" defaultValue="" required>
                              <option value="">Escolher correspondência</option>
                              <option value="__new__">
                                Criar nova conta no app
                              </option>
                              {accounts
                                .filter(
                                  (local) =>
                                    local.currency === a.currency &&
                                    (a.account_type === "CREDIT"
                                      ? local.kind === "card"
                                      : ["checking", "benefit"].includes(
                                          local.kind,
                                        )),
                                )
                                .map((local) => (
                                  <option value={local.id} key={local.id}>
                                    {local.name}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label>
                            Nome, se for criar uma conta
                            <input
                              name="name"
                              maxLength={120}
                              defaultValue={a.label}
                            />
                          </label>
                          <button disabled={busy}>Vincular esta conta</button>
                        </form>
                      )
                    )}
                  </div>
                ))}
              {c.own && !reader && (
                <div className="family-actions">
                  <button
                    disabled={busy || !c.enabled || !data.storageReady}
                    onClick={() =>
                      void work(async () => {
                        const r = await api<{ skipped: boolean }>(
                          "banks/read",
                          { id: c.id, force: true },
                        );
                        if (r.skipped)
                          throw new Error(
                            "Aguarde um minuto entre leituras ou conclua a leitura já em andamento.",
                          );
                      }, "Leitura concluída. Confira os movimentos abaixo.")
                    }
                  >
                    Ler atualização disponível
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void work(
                        () =>
                          api("banks/pause", { id: c.id, enabled: !c.enabled }),
                        c.enabled
                          ? "Consultas pausadas. O histórico foi preservado."
                          : "Consultas reativadas.",
                      )
                    }
                  >
                    {c.enabled ? "Pausar leitura" : "Retomar leitura"}
                  </button>
                </div>
              )}
              {c.own && !reader && (
                <a className="bank-external" href="#bank-onboarding">
                  Voltar ao passo a passo ↑
                </a>
              )}
              {c.own && !reader && (
                <RenewBank
                  connection={c.id}
                  busy={busy}
                  ready={data.storageReady}
                  completed={() =>
                    work(
                      async () => {},
                      "Autorização renovada, mantendo as mesmas contas. Leia os movimentos e confira possíveis duplicidades.",
                    )
                  }
                />
              )}
            </article>
          ))}
          {data.incomeRules.map((rule) => (
            <article className="bank-review" key={rule.id}>
              <h3>{rule.label} · entrada recorrente</h3>
              <p>
                {rule.receipt_mode === "business_window"
                  ? "Janela esperada: primeiros cinco dias úteis, após conversão de dólares pela Wise. Data e valor variam."
                  : `Dia ${rule.day}, antecipado para sexta quando cair no fim de semana.`}{" "}
                O recebimento financia{" "}
                {rule.budget_offset === 1 ? "o mês seguinte" : "o mesmo mês"}.
              </p>
              <p className="fine">
                {rule.account_name} · base {money(rule.expected_cents)} ·{" "}
                {rule.enabled ? "Ativa" : "Pausada"}. Previsões não confirmam
                receitas. Feriados e diferenças de valor precisam de revisão.
              </p>
              {!reader && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void work(
                      () =>
                        api("income/rule", {
                          account_id: rule.account_id,
                          label: rule.label,
                          match_text: rule.match_text,
                          day: rule.day,
                          expected_cents: rule.expected_cents,
                          effective_month: rule.effective_month.slice(0, 7),
                          enabled: !rule.enabled,
                          receipt_mode: rule.receipt_mode,
                          budget_offset: rule.budget_offset,
                        }),
                      "Regra atualizada. Os lançamentos foram preservados.",
                      true,
                    )
                  }
                >
                  {rule.enabled ? "Pausar previsão" : "Ativar previsão"}
                </button>
              )}
            </article>
          ))}
          <div className="family-section">
            <h3 id="bank-review-title" tabIndex={-1}>
              Movimentos para conferir
            </h3>
            <small>{data.total} pendentes ou com alertas</small>
          </div>
          <p className="fine">
            Só entram nos totais depois de conferidos. Se o movimento já
            existir, vincule a ele. Transferências próprias e faturas precisam
            da conta de destino.
          </p>
          <div className="bank-analysis-toolbar">
            <label>
              Conta ou cartão
              <select
                value={account}
                disabled={busy}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setOffset(0);
                  setSelected(null);
                }}
              >
                <option value="">Todas as contas</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Revisar por grupo
              <select
                value={group}
                disabled={busy}
                onChange={(e) => {
                  const value = e.target.value;
                  setGroup(value);
                  setSelected(null);
                  void load(0, value).catch((e) => setError(e.message));
                }}
              >
                <option value="">
                  Todos ({data.groups.reduce((n, g) => n + g.count, 0)})
                </option>
                {data.groups.map((g) => (
                  <option key={g.group} value={g.group}>
                    {reviewGroups[g.group as ReviewGroup] ||
                      "Ainda não analisados"}{" "}
                    ({g.count})
                  </option>
                ))}
              </select>
            </label>
            {!reader && (
              <button
                disabled={busy}
                onClick={() =>
                  void work(
                    () => api("banks/analyze", {}),
                    "Cruzamento atualizado. Nenhum lançamento foi confirmado.",
                    true,
                  )
                }
              >
                Atualizar cruzamento
              </button>
            )}
          </div>
          <p className="fine">
            A análise cruza os movimentos com o histórico e os extratos
            originais. Coincidência de valor e data é um indício; a decisão
            continua com vocês.
          </p>
          {data.reviews.map((row) => (
            <article className="bank-review" key={row.id}>
              <button
                className="bank-review-title"
                aria-expanded={selected === row.id}
                onClick={() => setSelected(selected === row.id ? null : row.id)}
              >
                <span>
                  <strong>{row.description}</strong>
                  <small>
                    {brDate(row.transaction_date)} · {row.account_name} ·{" "}
                    {row.owner_label}
                  </small>
                </span>
                <strong>{money(row.amount_cents)}</strong>
              </button>
              {row.analysis?.group && (
                <div className="bank-analysis-note">
                  <strong>{reviewGroups[row.analysis.group]}</strong>
                  <p>{row.analysis.reason}</p>
                  <p>{row.analysis.decision}</p>
                  {row.analysis.semantic && <p>{row.analysis.semantic}</p>}
                  {row.analysis.category_suggestion && (
                    <p>Sugestão: {row.analysis.category_suggestion}</p>
                  )}
                  {row.analysis.planning?.map((p, index) => (
                    <small key={index}>{p}</small>
                  ))}
                  {selected === row.id && (
                    <>
                      {!!row.analysis.event_ids?.length && (
                        <small>
                          {row.analysis.event_ids.length} coincidência(s) no
                          histórico.
                        </small>
                      )}
                      {!!row.analysis.staged_ids?.length && (
                        <small>
                          {row.analysis.staged_ids.length} coincidência(s) nos
                          extratos originais.
                        </small>
                      )}
                      {!!row.analysis.related_ids?.length && (
                        <small>
                          {row.analysis.related_ids.length} contrapartida(s) ou
                          repetição(ões) para conferir.
                        </small>
                      )}
                      {row.analysis.evidence?.map((e, index) => (
                        <small key={index}>{e}</small>
                      ))}
                    </>
                  )}
                </div>
              )}
              {(row.changed || row.missing) && (
                <p className="family-error">
                  {row.missing
                    ? "O banco deixou de retornar este movimento."
                    : "O banco alterou os dados deste movimento."}{" "}
                  {row.event_id
                    ? "O lançamento salvo não foi alterado; confira a conciliação antes de qualquer ajuste."
                    : "Confira a evidência antes de decidir."}
                </p>
              )}
              {row.provider_status !== "POSTED" && (
                <p className="fine">
                  Ainda pendente no banco. Não pode ser registrado nos totais.
                </p>
              )}
              {selected === row.id && (
                <div>
                  {row.latest_snapshot && (
                    <p className="fine">
                      Nova versão: {row.latest_snapshot.description} ·{" "}
                      {brDate(row.latest_snapshot.transaction_date)} ·{" "}
                      {money(row.latest_snapshot.amount_cents)}
                    </p>
                  )}
                  {!row.event_id && !reader && (
                    <>
                      {row.changed && !row.missing && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void work(
                              () =>
                                api("banks/review", {
                                  id: row.id,
                                  version: row.version,
                                  decision: "refresh",
                                }),
                              "Nova evidência preparada. Confira antes de registrar.",
                            )
                          }
                        >
                          Revisar nova versão
                        </button>
                      )}
                      {!row.changed &&
                        !row.missing &&
                        row.provider_status === "POSTED" && (
                          <>
                            {!!row.candidates.events.length && (
                              <form
                                onSubmit={(e) => {
                                  const v = fields(e);
                                  void work(
                                    () =>
                                      api("banks/review", {
                                        id: row.id,
                                        version: row.version,
                                        decision: "link",
                                        event_id: v.event_id,
                                        duplicate: v.duplicate === "on",
                                        note: v.note || "",
                                      }),
                                    "Evidência vinculada, sem criar outro lançamento.",
                                    true,
                                  );
                                }}
                              >
                                <label>
                                  Possível movimento já salvo
                                  <select name="event_id" required>
                                    {row.candidates.events.map((event) => (
                                      <option value={event.id} key={event.id}>
                                        {event.description} ·{" "}
                                        {brDate(event.transaction_date)} ·{" "}
                                        {money(event.amount_cents)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <button className="primary" disabled={busy}>
                                  Vincular ao existente
                                </button>
                              </form>
                            )}
                            {!!row.candidates.transfer.length && (
                              <p className="fine">
                                Há valor oposto em{" "}
                                {row.candidates.transfer
                                  .map((t) => t.account_name)
                                  .join(", ")}
                                . Pode ser transferência própria; confirme a
                                finalidade. Registre uma vez e vincule a outra
                                ponta ao mesmo movimento.
                              </p>
                            )}
                            <details>
                              <summary>Registrar como movimento novo</summary>
                              <NewBankMovement
                                row={row}
                                categories={categories}
                                accounts={accounts}
                                busy={busy}
                                submit={(body) =>
                                  work(
                                    () => api("banks/review", body),
                                    "Movimento salvo uma única vez. O planejamento não foi marcado como pago automaticamente.",
                                    true,
                                  )
                                }
                              />
                            </details>
                          </>
                        )}
                      <details>
                        <summary>Deixar fora dos totais</summary>
                        <form
                          onSubmit={(e) => {
                            const v = fields(e);
                            void work(
                              () =>
                                api("banks/review", {
                                  id: row.id,
                                  version: row.version,
                                  decision: "ignore",
                                  note: v.note,
                                }),
                              "Movimento mantido apenas como evidência.",
                            );
                          }}
                        >
                          <label>
                            Motivo
                            <input
                              name="note"
                              required
                              minLength={8}
                              maxLength={1000}
                            />
                          </label>
                          <button disabled={busy}>
                            Manter fora dos totais
                          </button>
                        </form>
                      </details>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
          {!data.reviews.length && (
            <p className="fine">
              Nenhum movimento aguardando revisão nesta página.
            </p>
          )}
          <div className="family-actions">
            <button
              disabled={busy || offset === 0}
              onClick={() =>
                void load(Math.max(0, offset - 30)).catch((e) =>
                  setError(e.message),
                )
              }
            >
              Anteriores
            </button>
            <button
              disabled={busy || !data.hasMore}
              onClick={() =>
                void load(offset + 30).catch((e) => setError(e.message))
              }
            >
              Próximos
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function NewBankMovement({
  row,
  categories,
  accounts,
  busy,
  submit,
}: {
  row: Banks["reviews"][number];
  categories: Category[];
  accounts: LocalAccount[];
  busy: boolean;
  submit: (body: unknown) => Promise<void>;
}) {
  const isCard =
    accounts.find((a) => a.id === row.local_account_id)?.kind === "card";
  const [kind, setKind] = useState(
    isCard
      ? row.amount_cents.startsWith("-")
        ? "card_purchase"
        : "card_payment"
      : row.amount_cents.startsWith("-")
        ? "expense"
        : "income",
  );
  const paired = [
    "transfer",
    "card_payment",
    "investment_buy",
    "investment_sell",
  ].includes(kind);
  return (
    <form
      onSubmit={(e) => {
        const v = fields(e);
        void submit({
          id: row.id,
          version: row.version,
          decision: "record",
          kind,
          category_id: paired ? null : v.category_id || null,
          counter_account_id: paired ? v.counter_account_id || null : null,
          staged_id: v.staged_id || null,
          note: v.note || "",
          distinct: v.distinct === "on",
        });
      }}
    >
      <label>
        O que aconteceu?
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {!isCard && (
            <>
              <option value="expense">Despesa</option>
              <option value="income">Entrada</option>
            </>
          )}
          <option value="transfer">Transferência própria</option>
          <option value="card_payment">Pagamento de fatura</option>
          <option value="card_purchase">Compra no cartão</option>
          <option value="fee">Tarifa</option>
          <option value="investment_buy">Aporte</option>
          <option value="investment_sell">Resgate</option>
          {!isCard && <option value="yield">Rendimento</option>}
        </select>
      </label>
      {paired ? (
        <label>
          {isCard && kind === "card_payment"
            ? "Conta que pagou a fatura"
            : "Outra conta da operação"}
          <select name="counter_account_id" required>
            <option value="">Escolher conta</option>
            {accounts
              .filter(
                (a) => a.currency === "BRL" && a.id !== row.local_account_id,
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      ) : (
        <label>
          Categoria
          <select name="category_id" required>
            <option value="">Escolher categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!!row.candidates.staged.length && (
        <label>
          Evidência do extrato já enviado
          <select name="staged_id">
            <option value="">Não corresponde a uma linha anterior</option>
            {row.candidates.staged.map((s) => (
              <option key={s.id} value={s.id}>
                {s.description} · {s.filename}
              </option>
            ))}
          </select>
        </label>
      )}
      {(!!row.candidates.events.length || !!row.candidates.staged.length) && (
        <label className="bank-consent">
          <input type="checkbox" name="distinct" />
          Conferi as coincidências: este é outro movimento, distinto dos já
          registrados.
        </label>
      )}
      <label>
        Observação ou justificativa
        <textarea
          name="note"
          maxLength={1000}
          placeholder="Explique as coincidências, se houver…"
        />
      </label>
      <p className="fine">
        Estornos sem a origem comprovada devem continuar para revisão. Marcar
        uma conta planejada como paga é uma ação separada, para não duplicar
        despesas.
      </p>
      <button disabled={busy} className="primary">
        Conferi · salvar movimento
      </button>
    </form>
  );
}

function RenewBank({
  connection,
  busy,
  ready,
  completed,
}: {
  connection: string;
  busy: boolean;
  ready: boolean;
  completed: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<Renewal | null>(null),
    [item, setItem] = useState(""),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false);
  return (
    <details>
      <summary>Renovar autorização sem criar outras contas</summary>
      <p className="fine">
        Depois de renovar no Meu Pluggy e autorizar novamente no painel, informe
        o novo itemId. Confira as correspondências; finais iguais e nomes
        parecidos não comprovam que são a mesma conta.
      </p>
      {error && (
        <p role="alert" className="family-error">
          {error}
        </p>
      )}
      {!preview ? (
        <form
          onSubmit={async (e) => {
            const v = fields(e);
            setWorking(true);
            setError("");
            try {
              const result = await api<Renewal>("banks/renew", {
                id: connection,
                item_id: v.item_id,
              });
              setItem(String(v.item_id));
              setPreview(result);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Tente novamente.");
            } finally {
              setWorking(false);
            }
          }}
        >
          <label>
            Novo itemId
            <input
              name="item_id"
              required
              maxLength={36}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button disabled={busy || working || !ready}>
            Conferir nova autorização
          </button>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            const v = fields(e);
            setWorking(true);
            setError("");
            try {
              await api("banks/renew", {
                id: connection,
                item_id: item,
                confirm: true,
                mappings: preview.previous.map((old) => ({
                  bank_account_id: old.id,
                  remote_account_id: v[old.id],
                })),
              });
              setPreview(null);
              await completed();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Tente novamente.");
            } finally {
              setWorking(false);
            }
          }}
        >
          {preview.previous.map((old) => (
            <label key={old.id}>
              {old.label}
              {old.last_four ? " · final " + old.last_four : ""}
              <select name={old.id} required defaultValue="">
                <option value="">
                  Escolha a mesma conta na nova autorização
                </option>
                {preview.remote
                  .filter(
                    (a) =>
                      a.currency === old.currency &&
                      a.account_type === old.account_type,
                  )
                  .map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.label}
                      {a.last_four ? " · final " + a.last_four : ""}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          <label className="bank-consent">
            <input type="checkbox" required />
            Conferi que são as mesmas contas. Quero preservar os vínculos e o
            histórico.
          </label>
          <button className="primary" disabled={busy || working}>
            Confirmar renovação dos vínculos
          </button>
          <button
            type="button"
            disabled={working}
            onClick={() => setPreview(null)}
          >
            Recomeçar conferência
          </button>
        </form>
      )}
    </details>
  );
}
