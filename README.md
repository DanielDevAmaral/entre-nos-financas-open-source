<p align="center"><img src="public/icons/icon-512-v3.png" width="128" height="128" alt="Logo Entre Nós: duas formas ascendentes unidas por um coração, sobre degradê lavanda e ameixa"></p>
<h1 align="center">Entre Nós</h1>
<p align="center">As contas, os planos e o futuro do casal em um só lugar.</p>
<p align="center"><a href="LICENSE">Licença MIT</a> · <a href="docs/INSTALACAO.md">Instalar</a> · <a href="docs/ONBOARDING.md">Primeiros passos</a> · <a href="docs/FAQ.md">FAQ</a> · <a href="SECURITY.md">Segurança</a></p>

Aplicação de finanças para casais, pensada para o celular, com instalação como PWA, temas claro/escuro e a **Judite**, assistente que consulta o histórico da família. O uso principal é simples: planejar o mês, acompanhar o que foi pago e registrar os imprevistos.

**Código aberto, instalação independente.** Este repositório começa sem usuários, banco preenchido, extratos, fotos de perfil, credenciais ou histórico financeiro real. Não há acesso compartilhado a uma instalação de produção nem conta de demonstração pública. Cada operador controla sua infraestrutura e seus segredos.

## Funcionalidades

- **Mês:** entradas previstas, custos fixos/variáveis, cartões, objetivos e gráfico por categoria. Marcar pago/recebido acompanha o plano sem duplicar movimentos.
- **Movimentos:** totais confirmados, busca, filtros e histórico por dia. Transferências próprias e pagamentos de fatura são separados do consumo.
- **Futuro:** posições e movimentos de investimentos com valores conhecidos, sem inventar cotação ou rentabilidade.
- **Judite:** consultas locais e integração opcional com IA externa/RAG dos meses disponíveis. Alterações geram uma prévia para confirmação.
- **Personalização:** foto, cor, tema e disposição dos cards por usuário; tour curto no primeiro acesso.
- **Famílias:** acessos individuais, permissões e isolamento. Novas famílias somente por administrador designado, sem inscrição pública.
- **Lembretes:** Web Push por aparelho, com teste; a entrega depende de instalação, permissões, navegador e sistema.
- **Histórico opcional:** adaptadores PDF/CSV/XLSX e Meu Pluggy em leitura, com revisão e proteção contra repetições. Layouts e cobertura variam.

## Instalação rápida

Requisitos: **Node.js 24+**, **Python 3.11+** e Git. O banco local vem embutido no servidor via PGlite; não é necessário instalar PostgreSQL para começar.

```sh
git clone https://github.com/DanielDevAmaral/entre-nos-financas-open-source.git
cd entre-nos-financas-open-source
npm ci
python -m venv .venv
```

**Windows / PowerShell:**

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env.local
```

**macOS / Linux:** use `python3` na criação do ambiente, se necessário.

```sh
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env.local
```

Em `.env.local`, defina `FINANCE_PYTHON` como o caminho absoluto do Python do ambiente virtual. Deixe `DATABASE_URL` ausente para o banco local.

```sh
npm run build
npm start
```

Abra **http://127.0.0.1:3210**. Para desenvolvimento: `npm run dev`. O servidor local fica limitado ao próprio computador. [Instalação detalhada e backup →](docs/INSTALACAO.md)

## Onboarding, passo a passo

1. **Crie o espaço:** informe nome, e-mail e senha de pelo menos 12 caracteres. Não existe senha padrão.
2. **Adicione a outra pessoa:** em Perfil → Nosso casal, crie um acesso individual de edição ou leitura. Entregue a senha por canal privado.
3. **Planeje o mês:** escolha o período na faixa do mês. Use o **+** para entradas, gastos e edição da tela; informe categorias e vencimentos.
4. **Acompanhe as contas:** marque pago/recebido e registre o que aconteceu fora do plano. Revise evidências antes de confirmar movimentos.
5. **Personalize:** escolha foto, cor, tema e ordem dos cards. As preferências acompanham a conta.
6. **Use a Judite:** informe o período na mensagem. As consultas locais funcionam sem compartilhar dados com um provedor de IA.
7. **Instale no celular:** depois de hospedar em HTTPS, adicione à Tela de Início e ative/teste notificações em cada aparelho.

[Onboarding completo →](docs/ONBOARDING.md) · [iPhone, Android e desktop →](docs/PWA.md)

## Hospedagem e integrações opcionais

O modo local é o padrão. Para vários aparelhos, opere uma instalação própria com **Vercel + PostgreSQL/Neon**, respeitando as condições dos provedores. Não há garantia de planos gratuitos permanentes. O projeto não cria contas nem oferece infraestrutura compartilhada.

| Recurso | Configuração no servidor |
| --- | --- |
| Banco remoto | `DATABASE_URL` restrita e `APP_ORIGIN` HTTPS exata |
| Migrations | `MIGRATION_DATABASE_URL`, só na sessão privada do operador |
| Primeiro acesso remoto | `SETUP_TOKEN` |
| Parser privado | `PARSER_TOKEN` |
| Lembretes agendados | `CRON_SECRET` e cron configurado |
| Meu Pluggy pessoal | `BANK_CONNECTIONS_KEY` e credenciais do titular pela interface |
| IA externa | Provedor, chave e modelo no servidor; consentimento no app |

Nunca coloque segredos em `NEXT_PUBLIC_*`, no Git ou em screenshots. [Hospedagem →](docs/HOSPEDAGEM.md) · [Variáveis e administração →](docs/CONFIGURACAO.md)

## FAQ

**O código público expõe minhas finanças?** O repositório não contém dados de uma instalação. Banco, documentos, fotos e segredos ficam fora do Git. Segurança também depende da operação do servidor; não há criptografia ponta a ponta.

**Preciso conectar bancos ou uma IA?** Não. Planejamento e registros manuais funcionam sem integrações. Elas são opcionais e exigem contas próprias.

**Podemos compartilhar um login?** Prefira acessos individuais. As finanças são familiares; conversas da Judite e preferências são pessoais.

**A Judite altera dados?** Ela prepara registros/edições permitidos; a gravação exige confirmar a prévia. Não executa pagamentos ou transferências bancárias.

**Ela consulta outros meses?** Sim, o histórico disponível da própria família. Informe o período para focar/comparar. Dados ausentes não são presumidos zerados.

**Funciona no iPhone?** Como PWA em HTTPS. Web Push exige instalação na Tela de Início e iOS/iPadOS compatível. Notificações dependem das permissões e não são alarmes de minuto exato.

**O Meu Pluggy é gratuito e ilimitado?** O projeto não garante cotas ou cobertura. Confira as condições do provedor. Não é fornecida uma aplicação central ou credencial compartilhada.

**Há recuperação por e-mail?** Não há recuperação automática nesta versão. Planeje a operação dos acessos e mantenha backups privados.

[FAQ completo e limites →](docs/FAQ.md)

## Arquitetura e qualidade

| Camada | Tecnologias |
| --- | --- |
| Interface/API | Next.js, React e TypeScript |
| Banco | PGlite local ou PostgreSQL remoto; RLS por família/usuário |
| Documentos | Python, openpyxl e pypdf |
| Notificações | Service worker, Web Push/VAPID e agendamento opcional |
| IA | Consultas locais e provedor externo opcional com RAG estruturado |

```sh
npm run security:check
npm run check:public
```

O harness verifica tipos, lint, regras financeiras, isolamento, autenticação, HTTP, artefatos e dependências com dados fictícios. Não acessa o banco de produção. Auditorias automatizadas reduzem riscos; não garantem ausência de vulnerabilidades.

Leia [CONTRIBUTING.md](CONTRIBUTING.md) para contribuir e [SECURITY.md](SECURITY.md) para reportar vulnerabilidades de forma privada. Não publique documentos, fotos, segredos ou provas com dados reais.

## Licença

[MIT](LICENSE). Dependências mantêm suas licenças. Código aberto não concede acesso a contas de serviços, bancos ou dados de outra instalação. A identidade visual **Afinidade / Futuro a dois** está nos ativos públicos; gere seus tamanhos com `scripts/generate-affinity-icons.mjs`.
