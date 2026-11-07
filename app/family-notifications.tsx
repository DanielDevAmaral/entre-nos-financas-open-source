"use client";
import { useCallback, useEffect, useState } from "react";
import { useAsyncAction } from "./use-async-action";

type Config = {
  publicKey: string;
  schedulerReady: boolean;
  enabledDevices: number;
  lastDelivery?: string | null;
};
type Device = {
  supported: boolean;
  needsInstall: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  platform: string;
};
async function request<T>(path: string, body?: unknown): Promise<T> {
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
async function readyWorker() {
  await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "O serviço de notificações não iniciou. Recarregue o app e tente novamente.",
              ),
            ),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
export function NotificationsPanel() {
  const [config, setConfig] = useState<Config | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const { busy, error, notice, setError, setNotice, run } = useAsyncAction({
    fallbackError: "Tente novamente.",
  });
  const refresh = useCallback(async () => {
    const ios =
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone =
      matchMedia("(display-mode: standalone)").matches ||
      !!(navigator as Navigator & { standalone?: boolean }).standalone;
    const supported =
      isSecureContext &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    const registration = supported
      ? await navigator.serviceWorker.getRegistration("/")
      : undefined;
    const subscription = registration
      ? await registration.pushManager.getSubscription()
      : null;
    setDevice({
      supported,
      needsInstall: ios && !standalone,
      permission:
        "Notification" in window ? Notification.permission : "unsupported",
      subscribed: !!subscription,
      platform: ios
        ? "iPhone / iPad"
        : /Android/.test(navigator.userAgent)
          ? "Android"
          : "Desktop",
    });
    setConfig(await request<Config>("notifications"));
  }, []);
  useEffect(() => {
    const update = () => {
      if (document.visibilityState !== "hidden")
        void refresh().catch((e) => setError(e.message));
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [refresh]);
  function work(action: () => Promise<void>) {
    void run(action, refresh);
  }
  async function enable() {
    if (!device || !config || !device.supported || device.needsInstall)
      throw new Error(
        "Instale e abra o app pela Tela de Início do iPhone para ativar as notificações.",
      );
    // Permission must be requested directly from the user's click, before network or worker waits.
    const permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
    if (permission !== "granted")
      throw new Error(
        "A permissão não foi concedida. Abra os ajustes de notificações do aparelho ou as permissões deste site no navegador.",
      );
    const registration = await readyWorker();
    const key = Uint8Array.from(
      atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    let subscription = await registration.pushManager.getSubscription();
    const previousKey = subscription?.options.applicationServerKey;
    if (
      subscription &&
      previousKey &&
      (new Uint8Array(previousKey).length !== key.length ||
        new Uint8Array(previousKey).some((v, i) => v !== key[i]))
    ) {
      await request("notifications/unsubscribe", {
        endpoint: subscription.endpoint,
      });
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    await request("notifications/subscribe", subscription.toJSON());
    setNotice(
      "Notificações ativadas neste aparelho. Agora envie um teste para conferir a entrega.",
    );
  }
  return (
    <section
      className="family-card notification-settings"
      aria-label="Configurar notificações"
    >
      <h2>Notificações</h2>
      <p>
        Receba um lembrete diário quando houver contas para conferir. Nomes e
        valores ficam protegidos dentro do app.
      </p>
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
      {device && (
        <div className="notification-device" role="status">
          <strong>{device.platform} · este aparelho</strong>
          <p>
            {device.needsInstall
              ? "Falta abrir o app pela Tela de Início."
              : !device.supported
                ? "Este navegador não oferece notificações Web Push. Tente um navegador compatível."
                : device.permission === "denied"
                  ? "Permissão bloqueada nos ajustes do aparelho ou navegador."
                  : device.permission !== "granted"
                    ? "Você ainda precisa permitir as notificações."
                    : device.subscribed
                      ? "Permissão concedida e inscrição presente. Envie um teste para confirmar."
                      : "Permissão concedida. Falta ativar este aparelho."}
          </p>
        </div>
      )}
      {device?.needsInstall && (
        <p className="fine">
          No iPhone/iPad com iOS 16.4 ou mais recente: Safari → Compartilhar →
          Adicionar à Tela de Início. Abra pelo ícone do Entre Nós e toque em
          Ativar neste aparelho.
        </p>
      )}
      {config && (
        <p className="fine">
          {config.enabledDevices} aparelho(s) ativado(s) neste acesso.{" "}
          {config.lastDelivery
            ? "Último lembrete aceito pelo serviço de push: " +
              new Date(
                config.lastDelivery + "T12:00:00-03:00",
              ).toLocaleDateString("pt-BR") +
              "."
            : "Ainda não há lembrete diário registrado como enviado."}
        </p>
      )}
      {config && !config.schedulerReady && (
        <p role="status" className="family-notice">
          O agendamento diário precisa ser ativado pelo administrador. Você já
          pode ativar este aparelho e testar a entrega.
        </p>
      )}
      <div className="family-actions">
        <button
          className="primary"
          disabled={
            busy ||
            !config ||
            !device?.supported ||
            device.needsInstall ||
            device.permission === "denied"
          }
          onClick={() => void work(enable)}
        >
          {busy ? "Aguarde…" : "Ativar neste aparelho"}
        </button>
        <button
          disabled={
            busy || !device?.subscribed || device.permission !== "granted"
          }
          onClick={() =>
            void work(async () => {
              const registration = await readyWorker();
              const sub = await registration.pushManager.getSubscription();
              if (!sub)
                throw new Error(
                  "Ative primeiro as notificações neste aparelho.",
                );
              await request("notifications/test", { endpoint: sub.endpoint });
              setNotice(
                "Teste aceito pelo serviço de push. Confira a notificação neste aparelho; isso não confirma que ela já apareceu na tela.",
              );
            })
          }
        >
          Enviar teste
        </button>
        <button
          disabled={busy || !device?.subscribed}
          onClick={() =>
            void work(async () => {
              const registration =
                await navigator.serviceWorker.getRegistration("/");
              const sub = await registration?.pushManager.getSubscription();
              if (sub) {
                await request("notifications/unsubscribe", {
                  endpoint: sub.endpoint,
                });
                await sub.unsubscribe();
              }
              setNotice("Notificações desativadas somente neste aparelho.");
            })
          }
        >
          Desativar neste aparelho
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void work(async () => {
              await refresh();
              setNotice("Diagnóstico atualizado.");
            })
          }
        >
          Verificar configuração
        </button>
      </div>
      <details>
        <summary>O teste não apareceu?</summary>
        <ul>
          <li>
            No iPhone, use o app instalado na Tela de Início. Confira Ajustes →
            Notificações → Entre Nós e os modos Foco.
          </li>
          <li>
            No Android, confira as permissões do site e do navegador, as
            notificações do sistema e a economia de bateria.
          </li>
          <li>
            No desktop, permita notificações no navegador e no sistema. Confira
            Não Perturbe e mantenha o navegador autorizado a funcionar em
            segundo plano.
          </li>
          <li>
            Se trocou de navegador ou reinstalou o app, ative novamente nesse
            aparelho. Cada instalação tem sua própria inscrição.
          </li>
        </ul>
      </details>
      <p className="fine">
        O lembrete diário é agendado para a janela entre 9h e 10h, no horário de
        Brasília. A entrega depende da conexão, do serviço de push e dos ajustes
        do aparelho; não é um alarme com horário exato.
      </p>
    </section>
  );
}
