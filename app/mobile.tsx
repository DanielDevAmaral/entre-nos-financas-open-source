"use client";
import { useEffect, useRef, useState } from "react";
export function MobileNav({
  current,
  items,
  select,
}: {
  current: string;
  items: string[][];
  select: (tab: string) => void;
}) {
  const [more, setMore] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (more) dialog.current?.showModal();
    else dialog.current?.close();
  }, [more]);
  const primary = [
    ["overview", "Início", "◫"],
    ["transactions", "Movimentos", "⇄"],
    ["budget", "Orçamento", "▤"],
    ["assistant", "Insights", "✦"],
  ];
  return (
    <>
      <nav className="mobile-nav" aria-label="Navegação móvel">
        {primary.map(([id, name, icon]) => (
          <button
            key={id}
            aria-current={current === id ? "page" : undefined}
            onClick={() => select(id)}
          >
            <span aria-hidden="true">{icon}</span>
            {name}
          </button>
        ))}
        <button
          aria-expanded={more}
          aria-haspopup="dialog"
          onClick={() => setMore(true)}
        >
          <span aria-hidden="true">☰</span>Mais
        </button>
      </nav>
      <dialog
        className="mobile-menu"
        ref={dialog}
        onCancel={() => setMore(false)}
        onClose={() => setMore(false)}
        aria-labelledby="mobile-menu-title"
      >
        <div className="section-title">
          <h2 id="mobile-menu-title">Seu espaço financeiro</h2>
          <button onClick={() => setMore(false)} aria-label="Fechar menu">
            ✕
          </button>
        </div>
        <nav aria-label="Todas as áreas">
          {items.map(([id, name, icon]) => (
            <button
              key={id}
              aria-current={current === id ? "page" : undefined}
              onClick={() => {
                select(id);
                setMore(false);
              }}
            >
              <span aria-hidden="true">{icon}</span>
              {name}
            </button>
          ))}
        </nav>
        <p className="fine">Acesso individual · finanças compartilhadas</p>
      </dialog>
    </>
  );
}

export function InstallApp() {
  const [offline, setOffline] = useState(false),
    [ios, setIos] = useState(false),
    [standalone, setStandalone] = useState(false);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    setIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        !!(navigator as Navigator & { standalone?: boolean }).standalone,
    );
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <>
      {offline && (
        <p className="offline-banner" role="status">
          Sem conexão com o servidor. Reconecte antes de salvar alterações.
        </p>
      )}
      {standalone && (
        <p role="status">O Entre Nós já está aberto como app neste aparelho.</p>
      )}
      {!standalone && (
        <details className="install-guide" open>
          <summary>Instalar no iPhone ou outro celular</summary>
          <p>
            {ios
              ? "No Safari, toque em Compartilhar, depois em Adicionar à Tela de Início e ative Abrir como App."
              : "No iPhone, abra no Safari e use Compartilhar → Adicionar à Tela de Início → Abrir como App. No Android, use Instalar app no menu do navegador."}
          </p>
          <p className="fine">
            Para o casal usar fora deste computador, é necessário o endereço
            HTTPS da versão hospedada. O endereço 127.0.0.1 pertence apenas ao
            aparelho em que foi aberto.
          </p>
        </details>
      )}
    </>
  );
}
