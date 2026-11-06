"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Currency } from "../src/domain/finance.ts";

import type {
  ChatMessage as Message,
  Conversation,
} from "../src/server/chat-history.ts";
type Snapshot = {
  conversation: Conversation;
  messages: Message[];
  hasOlder: boolean;
  before: number | null;
};
async function post<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const value = await r.json();
  if (!r.ok)
    throw new Error(
      value.error || "Não foi possível concluir. Tente novamente.",
    );
  return value;
}
// Render plain React nodes only: no raw HTML or provider-controlled links.
function MessageText({ text }: { text: string }) {
  return (
    <div className="chat-text">
      {text.split("\n").map((line, n) => (
        <p key={n}>
          {line
            .split(/(\*\*[^*]+\*\*)/g)
            .map((part, i) =>
              part.startsWith("**") && part.endsWith("**") ? (
                <strong key={i}>{part.slice(2, -2)}</strong>
              ) : (
                part
              ),
            ) || "\u00a0"}
        </p>
      ))}
    </div>
  );
}
export function HelpPanel({
  month,
  currency,
  hidden,
  record,
  refresh,
  reader,
  active,
}: {
  month: string;
  currency: Currency;
  hidden: boolean;
  record: () => void;
  refresh: () => Promise<void>;
  reader: boolean;
  active: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("IA");
  const [ready, setReady] = useState(false);
  const [external, setExternal] = useState(false);
  const [settings, setSettings] = useState(false);
  const request = useRef<AbortController | null>(null);
  const loadingRequest = useRef<AbortController | null>(null);
  const initialized = useRef(false);
  const sending = useRef(false);
  const resolving = useRef(false);
  const context = useRef(month + currency);
  const selected = useRef<string | null>(null);
  const selectSequence = useRef(0);
  const dataRevision = useRef(0);
  const retry = useRef<{
    id: string;
    question: string;
    external: boolean;
  } | null>(null);
  const stickToBottom = useRef(true);
  const preserveScroll = useRef<{ height: number; top: number } | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pending = messages.some((m) => m.pending);
  const referenceOnly = !!conversation && conversation.currency !== currency;
  async function list(append = false) {
    const r = await fetch(
      "/api/help/conversations?offset=" + (append ? conversations.length : 0),
      { cache: "no-store" },
    );
    const data = await r.json();
    if (!r.ok)
      throw new Error(
        data.error || "Não foi possível carregar suas conversas.",
      );
    setConversations((old) =>
      append
        ? [
            ...old,
            ...data.conversations.filter(
              (c: Conversation) => !old.some((o) => o.id === c.id),
            ),
          ]
        : data.conversations,
    );
    setHasMore(data.hasMore);
    return data.conversations as Conversation[];
  }
  function applySnapshot(data: Snapshot, merge = false) {
    setConversation(data.conversation);
    setMessages((old) =>
      merge
        ? [
            ...old.filter((m) => !data.messages.some((n) => n.id === m.id)),
            ...data.messages,
          ]
        : data.messages,
    );
    setHasOlder(data.hasOlder);
    setBefore(data.before);
  }
  async function choose(id: string) {
    if (sending.current || resolving.current) return;
    const sequence = ++selectSequence.current;
    loadingRequest.current?.abort();
    const c = new AbortController();
    loadingRequest.current = c;
    setLoading(true);
    setError("");
    try {
      const data = await post<Snapshot>(
        "help/conversations/open",
        { id },
        c.signal,
      );
      if (c.signal.aborted || sequence !== selectSequence.current) return;
      selected.current = id;
      context.current = data.conversation.month + currency;
      stickToBottom.current = true;
      retry.current = null;
      applySnapshot(data);
      setDraft("");
      setHistoryOpen(false);
    } catch (e) {
      if (!c.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Não foi possível abrir a conversa.",
        );
    } finally {
      if (sequence === selectSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    const c = new AbortController();
    void fetch("/api/help/status", { cache: "no-store", signal: c.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (s) {
          setReady(s.externalReady);
          setProvider(s.provider);
        }
      })
      .catch(() => {});
    return () => {
      c.abort();
      request.current?.abort();
      loadingRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active || initialized.current) return;
    initialized.current = true;
    void list()
      .then(async (rows) => {
        if (rows[0]) await choose(rows[0].id);
        else setLoading(false);
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
        initialized.current = false;
      });
  }, [active]);
  useEffect(() => {
    if (context.current === month + currency) return;
    context.current = month + currency;
    selectSequence.current++;
    loadingRequest.current?.abort();
    request.current?.abort();
    selected.current = null;
    setConversation(null);
    setMessages([]);
    setHasOlder(false);
    setBefore(null);
    setDraft("");
    setError("");
    setBusy(false);
    setLoading(false);
    sending.current = false;
    retry.current = null;
  }, [month, currency]);
  useEffect(() => {
    if (hidden) {
      request.current?.abort();
      setBusy(false);
      sending.current = false;
      setHistoryOpen(false);
    }
  }, [hidden]);
  useEffect(() => {
    const syncViewport = () => {
      const v = window.visualViewport;
      if (v && v.scale !== 1) return;
      const height = v?.height ?? window.innerHeight;
      document.documentElement.style.setProperty(
        "--chat-viewport-height",
        height + "px",
      );
      document.documentElement.dataset.chatKeyboard =
        window.innerHeight - height > 140 ? "open" : "closed";
    };
    syncViewport();
    window.visualViewport?.addEventListener("resize", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", syncViewport);
      window.removeEventListener("resize", syncViewport);
      document.documentElement.style.removeProperty("--chat-viewport-height");
      delete document.documentElement.dataset.chatKeyboard;
    };
  }, []);
  useEffect(() => {
    if (!active || !log.current) return;
    if (preserveScroll.current) {
      log.current.scrollTop =
        log.current.scrollHeight -
        preserveScroll.current.height +
        preserveScroll.current.top;
      preserveScroll.current = null;
    } else if (stickToBottom.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [messages, busy, active, hidden]);
  useEffect(() => {
    if (!active || !conversation?.id) return;
    const id = conversation.id;
    let ended = false;
    const c = new AbortController();
    async function sync() {
      if (
        ended ||
        document.hidden ||
        sending.current ||
        resolving.current ||
        selected.current !== id
      )
        return;
      const revision = dataRevision.current;
      try {
        const data = await post<Snapshot>(
          "help/conversations/open",
          { id },
          c.signal,
        );
        if (
          !ended &&
          selected.current === id &&
          revision === dataRevision.current &&
          !sending.current &&
          !resolving.current
        )
          applySnapshot(data, true);
      } catch {}
    }
    const interval = pending
      ? window.setInterval(() => void sync(), 4000)
      : null;
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      ended = true;
      c.abort();
      if (interval) window.clearInterval(interval);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [active, conversation?.id, pending]);
  async function newConversation() {
    if (sending.current || resolving.current || loading) return;
    setLoading(true);
    setError("");
    try {
      const c = await post<Conversation>("help/conversations", {
        id: crypto.randomUUID(),
        month,
        currency,
      });
      selected.current = c.id;
      setConversation(c);
      setMessages([]);
      setHasOlder(false);
      setBefore(null);
      setHistoryOpen(false);
      setDraft("");
      retry.current = null;
      stickToBottom.current = true;
      void list().catch(() => {});
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível criar a conversa.",
      );
    } finally {
      setLoading(false);
    }
  }
  async function older() {
    if (!conversation || !before || loading) return;
    setLoading(true);
    try {
      const data = await post<Snapshot>("help/conversations/open", {
        id: conversation.id,
        before,
      });
      preserveScroll.current = log.current
        ? { height: log.current.scrollHeight, top: log.current.scrollTop }
        : null;
      setMessages((old) => [...data.messages, ...old]);
      setBefore(data.before);
      setHasOlder(data.hasOlder);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Tente novamente.");
    } finally {
      setLoading(false);
    }
  }
  async function ask(question: string) {
    const q = question.trim();
    if (
      sending.current ||
      hidden ||
      referenceOnly ||
      loading ||
      pending ||
      q.length < 3 ||
      saving
    )
      return;
    sending.current = true;
    dataRevision.current++;
    setBusy(true);
    setError("");
    const c = new AbortController();
    request.current = c;
    try {
      let current = conversation;
      if (!current) {
        current = await post<Conversation>(
          "help/conversations",
          { id: crypto.randomUUID(), month, currency },
          c.signal,
        );
        selected.current = current.id;
        setConversation(current);
      }
      const turn =
        retry.current?.question === q && retry.current.external === external
          ? retry.current
          : { id: crypto.randomUUID(), question: q, external };
      retry.current = turn;
      stickToBottom.current = true;
      setMessages((old) => [
        ...old.filter(
          (m) => m.id !== turn.id + "-u" && m.id !== turn.id + "-a",
        ),
        { id: turn.id + "-u", role: "user", text: q },
      ]);
      setDraft("");
      const data = await post<{ messages: Message[] }>(
        "help/conversations/send",
        { id: current.id, request_id: turn.id, question: q, external },
        c.signal,
      );
      if (!c.signal.aborted && selected.current === current.id) {
        setMessages((old) => [
          ...old.filter((m) => !data.messages.some((n) => n.id === m.id)),
          ...data.messages,
        ]);
        retry.current = null;
        void list().catch(() => {});
      }
    } catch (e) {
      if (!c.signal.aborted) {
        setError(e instanceof Error ? e.message : "Tente novamente.");
        setDraft(q);
      }
    } finally {
      if (request.current === c) {
        setBusy(false);
        sending.current = false;
      }
    }
  }
  function stop() {
    request.current?.abort();
    setBusy(false);
    sending.current = false;
    setError(
      "A espera foi interrompida. A mensagem já enviada continua salva; atualize a conversa para conferir a resposta.",
    );
  }
  async function resolve(id: string, decision: "confirm" | "cancel") {
    if (
      resolving.current ||
      reader ||
      hidden ||
      referenceOnly ||
      busy ||
      loading
    )
      return;
    resolving.current = true;
    dataRevision.current++;
    setSaving(id);
    setError("");
    try {
      const result = await post<{ status: string }>("help/actions", {
        id,
        decision,
      });
      setMessages((ms) =>
        ms.map((m) =>
          m.action?.id === id
            ? { ...m, action: { ...m.action, status: result.status } }
            : m,
        ),
      );
      if (result.status === "confirmed")
        try {
          await refresh();
        } catch {
          setError(
            "A alteração foi salva. Atualize a página para recarregar os valores.",
          );
        }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível salvar. Confira antes de tentar novamente.",
      );
    } finally {
      resolving.current = false;
      setSaving("");
    }
  }
  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      e.key === "Enter" &&
      !e.shiftKey &&
      !e.nativeEvent.isComposing &&
      window.matchMedia("(pointer:fine)").matches
    ) {
      e.preventDefault();
      void ask(draft);
    }
  }
  return (
    <section className="family-chat" aria-label="Conversa com Judite">
      <header className="chat-toolbar">
        <button
          className="chat-mode"
          aria-expanded={settings}
          onClick={() => setSettings((s) => !s)}
        >
          <span className="chat-spark" aria-hidden="true">
            ✧
          </span>
          <span>
            <strong>Judite</strong>
            <small>
              Histórico da família · {external ? "Com IA" : "Sem envio externo"}
            </small>
          </span>
          <span aria-hidden="true">⌄</span>
        </button>
        <button
          className="chat-history-toggle"
          aria-label="Histórico de conversas"
          aria-expanded={historyOpen}
          disabled={busy || !!saving || hidden}
          onClick={() => {
            setHistoryOpen((v) => !v);
            void list().catch((e) => setError(e.message));
          }}
        >
          Histórico
        </button>
        <button
          className="chat-new"
          disabled={busy || !!saving || loading || hidden}
          aria-label="Nova conversa"
          title="Nova conversa"
          onClick={() => void newConversation()}
        >
          ＋
        </button>
      </header>
      {historyOpen && !hidden && (
        <section className="chat-history" aria-label="Suas conversas salvas">
          <div className="family-section">
            <h2>Suas conversas</h2>
            <button
              aria-label="Fechar histórico"
              onClick={() => setHistoryOpen(false)}
            >
              ×
            </button>
          </div>
          <p>
            Privadas para o seu acesso. Novas conversas não apagam as
            anteriores.
          </p>
          {!conversations.length ? (
            <p>A primeira conversa ficará salva aqui.</p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                className="chat-history-item"
                aria-current={c.id === conversation?.id ? "true" : undefined}
                disabled={loading}
                onClick={() => void choose(c.id)}
              >
                <strong>{c.title}</strong>
                <small>
                  {c.month} · {c.currency}
                </small>
              </button>
            ))
          )}
          {hasMore && (
            <button
              disabled={loading}
              onClick={() => void list(true).catch((e) => setError(e.message))}
            >
              Carregar mais conversas
            </button>
          )}
        </section>
      )}
      {settings && !historyOpen && (
        <div className="chat-settings">
          <p>
            Consulte todos os meses da família. Diga o período na pergunta para
            focar ou comparar meses. Para alterações, informe mês, valor e data.
          </p>
          <p>
            Suas conversas ficam salvas no banco privado, vinculadas ao seu
            acesso. Você pode retomá-las em outro aparelho; a outra pessoa da
            família tem seu próprio histórico.
          </p>
          {ready && !reader ? (
            <label className="family-consent">
              <input
                type="checkbox"
                checked={external}
                disabled={busy}
                onChange={(e) => setExternal(e.target.checked)}
              />
              <span>
                Usar {provider}. Autorizo enviar minhas mensagens recentes,
                totais dos meses disponíveis, nomes e valores dos compromissos
                do período da pergunta, categorias e nomes das contas para
                interpretar meus pedidos. Extratos, documentos e senhas não são
                enviados. Evite escrever dados pessoais.
              </span>
            </label>
          ) : (
            <p>
              {reader
                ? "Seu acesso permite apenas consultas locais."
                : "A IA externa ainda não está configurada. As consultas locais continuam disponíveis."}
            </p>
          )}
          <button onClick={() => setSettings(false)}>Pronto</button>
        </div>
      )}
      {hidden ? (
        <div className="chat-empty">
          <span aria-hidden="true">◌</span>
          <h2>Conversa protegida</h2>
          <p>Mostre os valores no topo para continuar.</p>
        </div>
      ) : (
        <>
          <div
            className="chat-log"
            ref={log}
            role="log"
            aria-label="Mensagens"
            aria-live={loading ? "off" : "polite"}
            aria-relevant="additions text"
            aria-busy={busy || loading}
            onScroll={() => {
              if (log.current)
                stickToBottom.current =
                  log.current.scrollHeight -
                    log.current.scrollTop -
                    log.current.clientHeight <
                  90;
            }}
          >
            {hasOlder && (
              <button
                className="chat-older"
                disabled={loading}
                onClick={() => void older()}
              >
                Carregar mensagens anteriores
              </button>
            )}
            {loading && (
              <p className="chat-loading" role="status">
                Carregando conversa…
              </p>
            )}
            {!messages.length && !loading && (
              <div className="chat-empty">
                <span className="chat-emblem" aria-hidden="true">
                  ✧
                </span>
                <h2>O que vamos cuidar hoje?</h2>
                <p>
                  Entenda o mês, planeje uma conta ou registre um gasto. Eu
                  preparo, vocês conferem.
                </p>
                <div className="chat-suggestions">
                  {[
                    "O que falta pagar neste mês?",
                    "Quanto sobra no planejamento?",
                    ...(external
                      ? [
                          "Quero planejar uma conta",
                          "Quero registrar uma despesa",
                        ]
                      : ["Como estão nossos investimentos?"]),
                  ].map((q) => (
                    <button key={q} disabled={busy} onClick={() => void ask(q)}>
                      {q}
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
                {!external && ready && !reader && (
                  <button
                    className="chat-enable"
                    onClick={() => setSettings(true)}
                  >
                    Ativar conversa com IA
                  </button>
                )}
              </div>
            )}
            {messages.map((m) => (
              <article
                className={`chat-message chat-${m.role}`}
                key={m.id}
                aria-label={m.role === "user" ? "Você" : "Judite"}
              >
                {m.role === "assistant" && (
                  <span className="chat-avatar" aria-hidden="true">
                    ✧
                  </span>
                )}
                <div className="chat-message-body">
                  <MessageText text={m.text} />
                  {m.action && (
                    <section
                      className="chat-action"
                      aria-label="Prévia da alteração"
                    >
                      <small>
                        {m.action.status === "confirmed"
                          ? "✓ SALVO"
                          : m.action.status === "cancelled"
                            ? "CANCELADO"
                            : m.action.status === "expired"
                              ? "PRÉVIA EXPIRADA"
                              : "PRÉVIA · AINDA NÃO SALVO"}
                      </small>
                      <h3>{m.action.title}</h3>
                      <ul>
                        {m.action.details.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                      {m.action.status === "pending" && (
                        <>
                          <p className="fine">
                            Válida por 30 minutos. Confira valores, contas e
                            datas.
                          </p>
                          <div className="chat-action-buttons">
                            <button
                              className="primary"
                              disabled={
                                !!saving ||
                                busy ||
                                reader ||
                                referenceOnly ||
                                loading
                              }
                              onClick={() =>
                                void resolve(m.action!.id, "confirm")
                              }
                            >
                              {saving === m.action.id
                                ? "Processando…"
                                : "Confirmar e salvar"}
                            </button>
                            <button
                              disabled={
                                !!saving ||
                                busy ||
                                reader ||
                                referenceOnly ||
                                loading
                              }
                              onClick={() =>
                                void resolve(m.action!.id, "cancel")
                              }
                            >
                              Cancelar
                            </button>
                          </div>
                        </>
                      )}
                    </section>
                  )}
                  {m.source && (
                    <details className="chat-sources">
                      <summary>Fontes e limites da resposta</summary>
                      <p>{m.source}</p>
                      <p>{m.coverage}</p>
                    </details>
                  )}
                </div>
              </article>
            ))}
            {busy && (
              <div className="chat-thinking" role="status">
                <span aria-hidden="true">✧</span> Pensando no seu pedido…
              </div>
            )}
          </div>
          <div className="chat-compose-wrap">
            {referenceOnly && (
              <p className="family-footnote">
                Esta conversa em {conversation?.currency} fica como referência.{" "}
                <button
                  disabled={loading}
                  onClick={() => void newConversation()}
                >
                  Conversar em reais
                </button>
              </p>
            )}
            {error && (
              <p className="family-error" role="alert">
                {error}{" "}
                {conversation && (
                  <button
                    type="button"
                    disabled={busy || loading}
                    onClick={() => void choose(conversation.id)}
                  >
                    Atualizar conversa
                  </button>
                )}
              </p>
            )}
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(draft);
              }}
            >
              <button
                type="button"
                className="chat-attach"
                aria-label="Abrir formulário de movimento"
                title="Registrar pelo formulário"
                disabled={
                  reader || referenceOnly || !!saving || busy || loading
                }
                onClick={record}
              >
                ＋
              </button>
              <label className="sr-only" htmlFor="chat-draft">
                Mensagem para Judite
              </label>
              <textarea
                id="chat-draft"
                name="message"
                autoComplete="off"
                enterKeyHint="enter"
                disabled={loading || referenceOnly}
                ref={input}
                rows={2}
                maxLength={600}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={keyDown}
                placeholder={
                  external
                    ? "Pergunte ou peça para registrar…"
                    : "Pergunte sobre o nosso mês…"
                }
              />
              {busy ? (
                <button
                  type="button"
                  className="chat-send"
                  onClick={stop}
                  aria-label="Parar resposta"
                >
                  ■
                </button>
              ) : (
                <button
                  className="chat-send"
                  disabled={
                    draft.trim().length < 3 ||
                    !!saving ||
                    loading ||
                    pending ||
                    referenceOnly
                  }
                  aria-label="Enviar mensagem"
                >
                  ↑
                </button>
              )}
            </form>
            <p className="chat-disclaimer">
              {external
                ? "A IA pode errar. Alterações só são salvas ao confirmar."
                : "Ajuda local para consultas. Ative a IA acima para pedir registros e edições."}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
