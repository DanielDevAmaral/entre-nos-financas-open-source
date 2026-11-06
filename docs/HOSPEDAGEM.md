# Hospedar uma instalação própria

O repositório público não está conectado a um banco pronto para uso. Crie seus próprios projetos e segredos. Vercel e Neon são uma opção compatível, sujeita aos planos, limites e condições atuais dos serviços. Não há promessa de gratuidade permanente.

## 1. Criar um banco vazio

Crie um projeto PostgreSQL/Neon dedicado à sua instalação. Guarde a conexão administrativa no ambiente privado do operador. Não copie o banco de outra instalação para testar.

Siga [Configuração](CONFIGURACAO.md) para aplicar migrations, criar um login de runtime restrito e separar os dois acessos. Execute `npm run migrate:db` com `MIGRATION_DATABASE_URL` somente na sessão administrativa local. Não configure essa variável na Vercel.

## 2. Preparar a aplicação

Faça um fork/cópia do código e importe **seu** repositório na Vercel. Use Next.js e Node 24. O projeto inclui `vercel.json`, `api/private_parser.py` e `requirements.txt` para o parser privado de documentos.

Descubra a URL HTTPS atribuída ao seu projeto. Nas variáveis de ambiente de **produção**, cadastre:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | Conexão PostgreSQL com o login restrito |
| `APP_ORIGIN` | Origem HTTPS exata da sua aplicação, sem barra final |
| `SETUP_TOKEN` | Segredo exclusivo para configuração inicial |
| `PARSER_TOKEN` | Outro segredo, disponível ao Node e à função Python |
| `CRON_SECRET` | Segredo independente para o cron de notificações |
| `NEXT_TELEMETRY_DISABLED` | `1` |

Os demais recursos são opcionais e estão em [Configuração](CONFIGURACAO.md). Nunca publique valores em screenshots. Produção e previews devem ter bancos e segredos separados; não dê a um preview acesso ao banco real.

## 3. Publicar e testar antes de inserir dados reais

Faça o deploy/redeploy depois de configurar variáveis. Abra a origem HTTPS correta e valide com dados fictícios: primeiro acesso, segundo membro, alteração do planejamento, registros, transferência, foto, isolamento e notificações. O parser sem token deve recusar acesso.

Se houver proteção de deployment bloqueando a chamada interna ao parser, resolva a configuração privada da plataforma; não remova sua autenticação. Não substitua a conexão restrita por uma administrativa para contornar um erro de inicialização.

## 4. Configurar o casal

Na instalação vazia, o primeiro cadastro solicita o código `SETUP_TOKEN`. Depois de concluir, o cadastro inicial fica bloqueado. Cadastre a outra pessoa no espaço familiar. Para operar outras famílias, designe um administrador conforme o guia; não há tela de autoinscrição.

Siga [Onboarding](ONBOARDING.md) e [PWA](PWA.md). Cada pessoa deve ativar notificações em cada aparelho. O cron em `vercel.json` faz a consulta diária de lembretes; a precisão depende da plataforma, do navegador e do sistema.

## 5. Operar com responsabilidade

Habilite MFA nos provedores, mantenha dependências atualizadas, proteja logs e teste restaurações. Não habilite captura de corpos de requisições, SQL com parâmetros ou telas financeiras em ferramentas de analytics.

O JSON exportado é uma cópia para consulta; não promete restauração completa. O backup npm é específico para o banco PGlite local. Para PostgreSQL remoto, configure backup/exportação privados do provedor. O roteiro não migra automaticamente dados financeiros reais; qualquer migração exige um destino validado, autorização e conferência de integridade.

Referências: [Vercel — variáveis de ambiente](https://vercel.com/docs/environment-variables), [Vercel — cron](https://vercel.com/docs/cron-jobs), [Neon — conectar uma aplicação](https://neon.com/docs/connect/connect-intro).
