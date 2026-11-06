# Instalar como aplicativo

Primeiro publique uma instalação própria em HTTPS, conforme [Hospedagem](HOSPEDAGEM.md). Cada pessoa usa sua conta. Não é preciso publicar na App Store para instalar a PWA.

## iPhone / iPad

1. No Safari, abra o endereço HTTPS da sua instalação e entre.
2. Toque em **Compartilhar → Adicionar à Tela de Início**.
3. Confirme o nome e, se disponível, **Abrir como app**.
4. Abra pelo ícone instalado.
5. Em **Perfil → Notificações**, toque em **Ativar neste aparelho** e permita o envio.
6. Toque em **Enviar teste** e confira a exibição. Repita no aparelho da outra pessoa.

Web Push requer iOS/iPadOS 16.4 ou posterior e a instalação na Tela de Início. O aceite do serviço de push não comprova exibição física; confira Foco e os ajustes do sistema se o teste não aparecer.

## Android

Abra no Chrome ou navegador compatível e use **Instalar app / Adicionar à tela inicial**. A nomenclatura varia. Ative notificações no próprio app e confira as permissões do navegador e do sistema.

## Desktop

No Chrome/Edge compatível, use a ação de instalação na barra de endereço ou menu do navegador. Também é possível usar pela aba. Ative e teste notificações separadamente nesse computador.

## Limites

O acesso depende do servidor. Dados financeiros não ficam disponíveis offline. Para atualização do ícone, pode ser necessário recriar o atalho; isso não apaga o banco. A base Capacitor em `ios/` é experimental e requer macOS, Xcode, assinatura e validação próprias; não é uma versão nativa pronta para distribuição.

Referência: [WebKit — Web Push no iOS/iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
