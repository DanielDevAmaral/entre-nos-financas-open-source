"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useAsyncAction } from "./use-async-action";
import { tourLayout } from "../src/domain/tour-layout";
import type { Preferences } from "../src/domain/preferences";
const steps = [
  {
    target: "month",
    title: "Um mês de cada vez",
    text: "Escolha o mês aqui. Abaixo ficam as entradas e contas que vocês planejaram.",
  },
  {
    target: "quick-actions",
    title: "Tudo começa no +",
    text: "Toque no + para adicionar entradas, registrar gastos ou editar os cards da tela. Em outros meses, use as opções para planejar.",
  },
  {
    target: "profile",
    title: "Com a sua cara",
    text: "Sua foto, cor e aparência ficam aqui. Cada pessoa tem suas próprias preferências.",
  },
  {
    target: "navigation",
    title: "O resto está sempre aqui",
    text: "Movimentos guarda o histórico. Futuro reúne investimentos e objetivos. Judite conversa com vocês sobre o histórico e os planos da família.",
  },
];
type Position = ReturnType<typeof tourLayout>;
export function GuidedTour({
  preferences,
  onSaved,
  replay,
  onClose,
  onStart,
}: {
  preferences: Preferences;
  onSaved: (p: Preferences) => void;
  replay: boolean;
  onClose: () => void;
  onStart: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    bubble = useRef<HTMLDivElement>(null),
    start = useRef(onStart),
    [step, setStep] = useState(0),
    [position, setPosition] = useState<Position | null>(null);
  const { busy, error, run } = useAsyncAction({
    fallbackError: "Não foi possível concluir.",
  });
  start.current = onStart;
  const open = replay || !preferences.onboarding_done,
    uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  useEffect(() => {
    if (open) {
      setStep(0);
      setPosition(null);
      start.current();
      dialog.current?.showModal();
    } else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let frame = 0,
      tries = 0,
      element: HTMLElement | null = null;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(
        `[data-tour="${steps[step].target}"]`,
      );
      if (!el) return;
      const r = el.getBoundingClientRect(),
        v = window.visualViewport;
      const next = tourLayout(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        {
          left: v?.offsetLeft ?? 0,
          top: v?.offsetTop ?? 0,
          width: v?.width ?? window.innerWidth,
          height: v?.height ?? window.innerHeight,
        },
        bubble.current?.getBoundingClientRect().height || 230,
      );
      setPosition((old) =>
        JSON.stringify(old) === JSON.stringify(next) ? old : next,
      );
    };
    const locate = () => {
      element = document.querySelector<HTMLElement>(
        `[data-tour="${steps[step].target}"]`,
      );
      if (!element && tries++ < 30) {
        frame = requestAnimationFrame(locate);
        return;
      }
      element?.scrollIntoView({ block: "center", behavior: "instant" });
      measure();
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(locate);
    const observer = new ResizeObserver(measure);
    if (bubble.current) observer.observe(bubble.current);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [open, step]);
  async function finish() {
    const ok = await run(async () => {
      if (!preferences.onboarding_done) {
        const r = await fetch("/api/profile/onboarding", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const p = await r.json();
        if (!r.ok) throw new Error(p.error || "Não foi possível concluir.");
        onSaved(p);
      }
    });
    if (ok) {
      dialog.current?.close();
      onClose();
    }
  }
  return (
    <dialog
      ref={dialog}
      className="guided-tour"
      aria-labelledby="guided-title"
      aria-describedby="guided-description"
      onCancel={(e) => {
        e.preventDefault();
        void finish();
      }}
    >
      <svg
        className="guided-shade"
        width="100%"
        height="100%"
        aria-hidden="true"
      >
        <defs>
          <mask id={"tour-mask-" + uid}>
            <rect width="100%" height="100%" fill="white" />
            {position && (
              <rect
                x={position.x}
                y={position.y}
                width={position.w}
                height={position.h}
                rx="14"
                fill="black"
              />
            )}
          </mask>
          <marker
            id={"tour-arrow-" + uid}
            markerWidth="8"
            markerHeight="8"
            refX="6"
            refY="3"
            orient="auto"
          >
            <path
              d="M0 0 L6 3 L0 6"
              fill="none"
              stroke="white"
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(9,15,12,.76)"
          mask={"url(#tour-mask-" + uid + ")"}
        />
        {position && (
          <>
            <rect
              x={position.x}
              y={position.y}
              width={position.w}
              height={position.h}
              rx="14"
              stroke="white"
              strokeWidth="2"
              fill="none"
            />
            <path
              d={position.arrow}
              fill="none"
              stroke="white"
              strokeWidth="2"
              markerEnd={"url(#tour-arrow-" + uid + ")"}
            />
          </>
        )}
      </svg>
      <div
        ref={bubble}
        className="guided-bubble"
        style={
          position
            ? {
                left: position.left,
                top: position.top,
                width: position.width,
                maxHeight: position.maxHeight,
              }
            : { left: 16, top: 80 }
        }
      >
        <div className="guided-meta">
          <span>
            Conheça seu espaço · {step + 1}/{steps.length}
          </span>
          <button
            type="button"
            disabled={busy}
            aria-label="Fechar apresentação"
            onClick={() => void finish()}
          >
            ×
          </button>
        </div>
        <h2 id="guided-title">{steps[step].title}</h2>
        <p id="guided-description">{steps[step].text}</p>
        <div className="guided-actions">
          {step > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep(step - 1)}
            >
              Voltar
            </button>
          )}
          {step < steps.length - 1 ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => setStep(step + 1)}
            >
              Próximo
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void finish()}
            >
              {busy ? "Salvando…" : "Entendi"}
            </button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </dialog>
  );
}
