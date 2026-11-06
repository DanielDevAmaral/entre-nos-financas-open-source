# Segurança e privacidade

## Relatar vulnerabilidades

Use **Security → Advisories → Report a vulnerability** no GitHub, quando habilitado. Não coloque dados pessoais ou segredos em issues públicas. Se esse canal estiver indisponível, abra uma issue apenas pedindo um meio privado de contato, sem detalhes exploráveis.

Inclua versões, passos com dados fictícios, impacto e reprodução mínima. Não teste contra instalações de terceiros nem acesse outras famílias. Não existe promessa de prazo de resposta ou programa de recompensa.

## Controles e limites

Há sessões autenticadas, scrypt, autorização no servidor, origem/host estritos, proteção CSRF, rate limiting, validação de entradas e RLS. A credencial de runtime é separada da administração do banco. Credenciais bancárias são cifradas; integrações são de leitura. Fotos são privadas, reduzidas e sem metadados. Escritas da Judite exigem confirmar uma prévia.

Não há criptografia ponta a ponta. O banco local não é cifrado em repouso pelo app. O operador de infraestrutura tem responsabilidade e capacidade técnica de acesso ao banco. Proteja dispositivos, arquivos, backups e provedores; habilite MFA e teste restaurações. Uma execução arbitrária no servidor continua sendo um incidente grave.

Não versione `.env`, dumps, extratos, exports, fotos pessoais ou relatórios de produção. A revisão da cópia pública e do histórico inicial não substitui uma auditoria independente completa. Dados ausentes e histórico incompleto não comprovam saldo bancário ou rentabilidade.
