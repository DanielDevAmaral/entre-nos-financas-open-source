# Configuração e administração

As variáveis de produção pertencem ao gerenciador de segredos do seu servidor. `.env.example` tem somente exemplos. `.env.local` é privado e ignorado pelo Git. Não use prefixo `NEXT_PUBLIC_` para senhas, tokens ou URLs com credenciais.

## Modo local

`PORT` é a porta, com padrão 3210. `FINANCE_DATA_DIR` muda a pasta privada de dados. `FINANCE_PYTHON` aponta para o executável Python. `NEXT_TELEMETRY_DISABLED=1` desliga a telemetria de desenvolvimento do Next.js. Sem `DATABASE_URL`, o app usa PGlite local.

## Banco remoto: dois acessos distintos

- `MIGRATION_DATABASE_URL`: somente na sessão privada do operador. Permite preparar o esquema com `npm run migrate:db`.
- `DATABASE_URL`: login restrito usado pelo app. Não pode ser proprietário do banco/tabelas, superusuário, criar roles/bancos ou ignorar RLS. O servidor recusa um acesso administrativo.
- `APP_ORIGIN`: origem HTTPS exata, sem barra final ou caminho, da **sua** instalação.

Use um PostgreSQL dedicado a esta instalação. Execute as migrations com o acesso administrativo. Elas criam os papéis `family_runtime` e `family_app`; isso não cria um login com senha.

No cliente SQL administrativo, crie um login próprio e atribua as permissões de runtime. Exemplo para psql, em um banco dedicado:

```sql
CREATE ROLE entre_nos_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
GRANT family_runtime TO entre_nos_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
```

Use `\password entre_nos_runtime` no psql para definir a senha interativamente; não a inclua em scripts versionados. Configure a URL com esse login apenas no segredo `DATABASE_URL`. Confirme também que o papel não herda propriedade/administração de outros papéis e que não tem CREATE no banco. O provedor deve suportar as permissões exigidas; não contorne a verificação do app colocando a conexão administrativa em produção.

Para novas migrations, use o acesso administrativo local e só então publique o código compatível. O runtime não executa migrations na inicialização.

## Segredos da aplicação

Gere valores independentes, com pelo menos 32 caracteres, para `SETUP_TOKEN`, `PARSER_TOKEN` e `CRON_SECRET`. Um gerador local possível:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Execute separadamente para cada segredo, guarde o resultado em um gerenciador privado e não publique o terminal. `SETUP_TOKEN` protege o primeiro cadastro remoto. `PARSER_TOKEN` autentica a função Python privada. `CRON_SECRET` protege o agendamento de lembretes.

`BANK_CONNECTIONS_KEY` deve ser uma chave base64 de exatamente 32 bytes aleatórios, gerada localmente pelo mesmo comando. Ela cifra credenciais bancárias. Não a troque sem um plano de recriptografia e backup: perder a chave impede ler credenciais já salvas.

## Administrador da instalação

Criar o primeiro casal não concede automaticamente administração de outras famílias. Um operador, usando acesso administrativo privado, pode designar uma conta já existente. No psql:

```sql
\prompt 'E-mail da conta administradora existente: ' admin_email
INSERT INTO platform_administrators(user_id)
SELECT id FROM users WHERE lower(email)=lower(:'admin_email')
ON CONFLICT DO NOTHING;
```

Confira o destinatário e o resultado antes de conceder o acesso. Essa associação permite cadastrar/listar famílias, não consultar suas finanças pela área administrativa. Não existe endpoint para autopromoção. O operador de infraestrutura pode tecnicamente acessar o banco; isso não é criptografia ponta a ponta. Use contas individuais e senhas iniciais temporárias entregues por canal privado. O limite atual é 30 usuários.

## Meu Pluggy, opcional

Configure `BANK_CONNECTIONS_KEY` no servidor. No perfil, o guia de Bancos conectados orienta cada titular a usar **as próprias** credenciais pessoais, informar os identificadores de suas conexões e corresponder as contas. Não reutilize dados de outra pessoa/família. A integração lê recursos autorizados, não inicia pagamentos. Não há aplicação central ou gratuidade ilimitada oferecida pelo projeto.

Credenciais e autorizações dependem do provedor. Consulte [Meu Pluggy — uso pessoal](https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use) antes de habilitar.

## Judite e IA externa, opcionais

A ajuda local funciona sem chave. Para Groq, configure no servidor `AI_PROVIDER=groq`, `GROQ_API_KEY` e um `GROQ_MODEL` compatível. Defina `GROQ_ZDR_CONFIRMED=true` **somente depois** de confirmar/ativar Zero Data Retention na conta do provedor. A variável por si só não altera a retenção no serviço externo. Há também suporte a `AI_PROVIDER=openai`, `OPENAI_API_KEY` e `OPENAI_MODEL`.

Cada pessoa habilita o envio indicado na interface. A IA recebe mensagens e contexto financeiro autorizado, não o arquivo bruto do extrato nem credenciais bancárias. Não existe fallback automático para serviço pago. Verifique cotas, custos, modelos e políticas atuais do provedor. A resposta pode errar e não confirma gravações; alterações exigem uma prévia aceita pelo usuário.
