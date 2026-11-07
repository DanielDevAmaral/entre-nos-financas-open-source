"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type OnSuccess = string | (() => void | Promise<void>);

/**
 * Estado de uma ação assíncrona da UI (salvar, enviar, confirmar): controla
 * `busy`, mostra `error`/`notice` e nunca engole o erro real.
 *
 * Boas práticas embutidas:
 * - loga o erro original no console (stack preservada) antes de derivar o texto
 *   visível, para não perder a causa de falhas;
 * - graceful degradation: se `action` deu certo mas o `onSuccess` (ex. um
 *   refresh) falha, mantém o sucesso na UI e só loga o erro do refresh — não
 *   mente dizendo que a ação falhou;
 * - guarda contra reentrância (clique duplo) por ref síncrona, não pelo state
 *   `busy` defasado no closure;
 * - ignora atualizações de estado após unmount;
 * - `run` tem identidade estável (useCallback sem deps).
 */
export function useAsyncAction(options?: { fallbackError?: string }) {
  const fallbackError = options?.fallbackError ?? "Não foi possível concluir.";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const mounted = useRef(true);
  const running = useRef(false);
  const fallback = useRef(fallbackError);
  fallback.current = fallbackError;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const clear = useCallback(() => {
    if (!mounted.current) return;
    setError("");
    setNotice("");
  }, []);

  const run = useCallback(
    async (
      action: () => Promise<void>,
      onSuccess?: OnSuccess,
    ): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      if (mounted.current) {
        setBusy(true);
        setError("");
        setNotice("");
      }
      try {
        await action();
        if (typeof onSuccess === "function") {
          // Pós-sucesso (ex. refresh): sua falha degrada suave — não derruba o
          // sucesso já concretizado, só vai para o console.
          try {
            await onSuccess();
          } catch (refreshError) {
            console.error(
              "useAsyncAction: a ação concluiu, mas o pós-sucesso falhou.",
              refreshError,
            );
          }
        } else if (typeof onSuccess === "string" && mounted.current) {
          setNotice(onSuccess);
        }
        return true;
      } catch (actionError) {
        // Nunca engole: o erro original (com stack) vai para o console.
        console.error(actionError);
        if (mounted.current) {
          setError(
            actionError instanceof Error && actionError.message
              ? actionError.message
              : fallback.current,
          );
        }
        return false;
      } finally {
        running.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [],
  );

  return { busy, error, notice, setError, setNotice, clear, run };
}
