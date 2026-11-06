# Instalação local

Cada instalação começa vazia. Este repositório não contém um banco de demonstração, contas de usuários, documentos bancários ou credenciais de outra instalação.

## Requisitos

- Node.js 24 ou superior, com npm.
- Python 3.11 ou superior, com pip e venv, para os adaptadores PDF/XLSX.
- Git e um navegador atualizado.

## Windows / PowerShell

```powershell
git clone https://github.com/DanielDevAmaral/entre-nos-financas-open-source.git
cd entre-nos-financas-open-source
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env.local
```

Edite `.env.local` e informe o caminho absoluto do Python do ambiente virtual em `FINANCE_PYTHON`. Exemplo genérico: `FINANCE_PYTHON=C:/projetos/entre-nos/.venv/Scripts/python.exe`. Não coloque senhas reais no exemplo versionado.

```powershell
npm run build
npm start
```

Abra **http://127.0.0.1:3210**. Alternativamente, `INICIAR.cmd` prepara e abre a execução no Windows. O processo precisa permanecer em execução; Ctrl+C encerra o servidor.

## macOS / Linux

```sh
git clone https://github.com/DanielDevAmaral/entre-nos-financas-open-source.git
cd entre-nos-financas-open-source
npm ci
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env.local
```

Defina `FINANCE_PYTHON` em `.env.local` como o caminho absoluto de `.venv/bin/python`.

```sh
npm run build
npm start
```

## Desenvolvimento

Use `npm run dev` e o mesmo endereço local. Sem `DATABASE_URL`, o servidor usa PGlite em `data/postgres`, criando o esquema automaticamente. A porta local fica limitada a `127.0.0.1`; não a exponha diretamente na internet.

## Dados e cópias de segurança

`data/`, `private/`, `work/` e os arquivos `.env` são ignorados pelo Git. Não abra duas instâncias usando o mesmo diretório de dados. O banco local não é cifrado pela aplicação em repouso: proteja o dispositivo e as permissões de arquivos. Para backup local, configure `BACKUP_PASSWORD` somente na sessão privada e consulte `npm run backup`. Guarde backup e senha em locais distintos. Para um banco remoto, use também as ferramentas privadas de backup do provedor.

Para acessar em aparelhos diferentes, siga [Hospedagem](HOSPEDAGEM.md); o endereço `127.0.0.1` de um iPhone não aponta para o computador.
