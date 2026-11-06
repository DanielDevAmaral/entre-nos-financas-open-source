"use client";
import { HomeDisclosure } from "./home-disclosure";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  homeCards,
  reorderCard,
  moveVisibleCard,
  type HomeCardId,
  type Preferences,
} from "../src/domain/preferences";
export function HomeLayout({
  preferences,
  children,
  editing,
  onEditingChange,
  onSaved,
}: {
  preferences: Preferences;
  children: ReactNode;
  editing: boolean;
  onEditingChange: (v: boolean) => void;
  onSaved: (p: Preferences) => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    drag = useRef<{
      id: HomeCardId;
      y: number;
      start: number;
      moving: boolean;
    } | null>(null);
  const [draft, setDraft] = useState(preferences),
    [dragging, setDragging] = useState<HomeCardId | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (editing) {
      setDraft(preferences);
      setMessage("");
    }
    drag.current = null;
    setDragging(null);
  }, [editing]);
  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    const tick = () => {
      const y = drag.current?.y;
      if (y !== undefined) {
        const speed = y < 95 ? -14 : y > window.innerHeight - 110 ? 14 : 0;
        if (speed) window.scrollBy(0, speed);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);
  const blocks = Children.toArray(children).filter(
      isValidElement<{ cardId: HomeCardId; caption?: string }>,
    ),
    p = editing ? draft : preferences;
  const visible = p.card_order.filter((id) => !p.hidden_cards.includes(id));
  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/profile/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision: draft.revision,
          card_order: draft.card_order,
          hidden_cards: draft.hidden_cards,
        }),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error || "Não foi possível salvar.");
      onSaved(result);
      onEditingChange(false);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      ref={root}
      className={"personal-home" + (editing ? " is-editing" : "")}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const id = d.id;
        d.y = e.clientY;
        if (!d.moving && Math.abs(e.clientY - d.start) < 6) return;
        d.moving = true;
        setDragging(id);
        const nodes = Array.from(
          root.current?.querySelectorAll<HTMLElement>("[data-home-card]") ?? [],
        ).filter((n) => n.dataset.homeCard !== id);
        let nearest: HTMLElement | undefined,
          dist = Infinity;
        for (const node of nodes) {
          const r = node.getBoundingClientRect(),
            distance = Math.abs(e.clientY - (r.top + r.height / 2));
          if (distance < dist) {
            dist = distance;
            nearest = node;
          }
        }
        if (nearest) {
          const r = nearest.getBoundingClientRect(),
            target = nearest.dataset.homeCard as HomeCardId;
          setDraft((old) => ({
            ...old,
            card_order: reorderCard(
              old.card_order,
              id,
              target,
              e.clientY > r.top + r.height / 2,
            ),
          }));
        }
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
        drag.current = null;
        setDragging(null);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(null);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(null);
      }}
    >
      {editing && (
        <div
          className="home-edit-toolbar"
          role="region"
          aria-label="Editar tela principal"
        >
          <div>
            <strong>Seu mês, do seu jeito</strong>
            <small>
              Arraste pela alça, use as setas ou remova um card. Seus dados
              ficam guardados.
            </small>
          </div>
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => onEditingChange(false)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "Salvando…" : "Concluir"}
            </button>
          </div>
          {message && <p role="alert">{message}</p>}
        </div>
      )}
      {visible.map((id, index) => {
        const block = blocks.find((b) => b.props.cardId === id),
          label = homeCards.find((c) => c[0] === id)![1];
        if (!block) return null;
        return (
          <div
            key={id}
            className={
              "personal-home-block" + (dragging === id ? " is-dragging" : "")
            }
            data-home-card={id}
          >
            {editing && (
              <div className="home-card-tools">
                <button
                  type="button"
                  className="home-drag-handle"
                  disabled={busy}
                  aria-label={"Arrastar " + label}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    root.current?.setPointerCapture(e.pointerId);
                    drag.current = {
                      id,
                      y: e.clientY,
                      start: e.clientY,
                      moving: false,
                    };
                  }}
                >
                  <span aria-hidden="true">⠿</span>
                  <span>{label}</span>
                </button>
                <div>
                  <button
                    type="button"
                    disabled={busy || index === 0}
                    aria-label={"Subir " + label}
                    onClick={() =>
                      setDraft((old) => ({
                        ...old,
                        card_order: moveVisibleCard(
                          old.card_order,
                          old.hidden_cards,
                          id,
                          -1,
                        ),
                      }))
                    }
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={busy || index === visible.length - 1}
                    aria-label={"Descer " + label}
                    onClick={() =>
                      setDraft((old) => ({
                        ...old,
                        card_order: moveVisibleCard(
                          old.card_order,
                          old.hidden_cards,
                          id,
                          1,
                        ),
                      }))
                    }
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="home-remove-card"
                    aria-label={"Remover " + label + " da tela"}
                    onClick={() =>
                      setDraft((old) => ({
                        ...old,
                        hidden_cards: [...old.hidden_cards, id],
                      }))
                    }
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            <div className="home-card-preview" inert={editing}>
              {editing ? (
                block
              ) : (
                <HomeDisclosure
                  cardId={id}
                  title={label}
                  caption={block.props.caption}
                  initiallyOpen={id === "fixed" || id === "variable"}
                >
                  {block}
                </HomeDisclosure>
              )}
            </div>
          </div>
        );
      })}
      {editing && (
        <details className="home-add-cards">
          <summary>
            ＋ Adicionar cards
            {p.hidden_cards.length ? ` (${p.hidden_cards.length})` : ""}
          </summary>
          <p className="fine">Toque para trazer um card de volta.</p>
          {p.hidden_cards.length ? (
            p.card_order
              .filter((id) => p.hidden_cards.includes(id))
              .map((id) => (
                <button
                  type="button"
                  key={id}
                  disabled={busy}
                  onClick={() =>
                    setDraft((old) => ({
                      ...old,
                      hidden_cards: old.hidden_cards.filter((x) => x !== id),
                    }))
                  }
                >
                  ＋ {homeCards.find((c) => c[0] === id)![1]}
                </button>
              ))
          ) : (
            <p>Todos os cards já estão na sua tela.</p>
          )}
        </details>
      )}
      {!editing && visible.length === 0 && (
        <p className="family-card">
          Sua tela está vazia. Toque no + e em “Editar tela” para adicionar
          cards.
        </p>
      )}
      <span role="status" className="home-editor-status">
        {editing && dragging
          ? "Movendo " + homeCards.find((c) => c[0] === dragging)![1]
          : ""}
      </span>
    </div>
  );
}
