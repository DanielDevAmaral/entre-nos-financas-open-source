# Verificação para publicação do código

Data: 06/11/2026. Escopo: esta distribuição pública independente, seus arquivos versionados, dependências, artefatos de build e histórico inicial. A versão é disponibilizada para instalação própria, sem um banco de demonstração ou acesso compartilhado.

## Resultado

Aprovada para publicar o código após saneamento. O histórico operacional anterior não foi incorporado a este repositório. Os documentos de operação da instalação de origem não fazem parte da distribuição. Não é uma auditoria independente nem uma garantia de ausência de vulnerabilidades.

## Controles de privacidade

- Arquivos exportados por uma lista de arquivos versionados, sem copiar diretórios de dados, documentos privados, caches, variáveis de ambiente, chaves ou backups.
- Relatórios particulares excluídos; guias públicos escritos para uma instalação vazia.
- Exemplos de conexões substituídos por identificadores fictícios e valores de testes inventados.
- Exceções com pessoas, pagadores ou períodos de viagem removidas das regras globais. Recebimentos configuráveis pertencem à família e à conta correspondentes.
- Histórico Git novo e autoria de commit com endereço não pessoal. Sem importar logs, artifacts, issues ou releases da operação anterior.
- Varredura local de segredos com Gitleaks e inspeção de possíveis identificadores. Os relatórios detalhados de saneamento permanecem privados.
- Checagem automática de arquivos proibidos, exemplos de conexão e links locais. CI com permissões de leitura, checkout sem credenciais persistidas e varredura do histórico por binário de versão/checksum fixos.

## Testes e dependências

95 testes TypeScript e 27 testes Python passaram, além de lint, tipos, build, testes HTTP, verificação dos arquivos de hospedagem e auditoria de dependências. Os testes usam dados fictícios, sem banco ou contas bancárias de produção. O servidor de regressão ignora arquivos .env locais e recebe explicitamente as credenciais externas vazias. O ambiente Python é instalado de forma independente para validar todos os adaptadores.

Foram atualizadas dependências de desenvolvimento para corrigir os avisos de `glob` e `minimatch`. A resolução de `minimatch` do parser TypeScript está fixada em uma versão corrigida por override, validada com o lint e os testes. A auditoria npm completa não indicou vulnerabilidades conhecidas na revisão; o resultado pode mudar com novos avisos.

As mudanças funcionais concentram-se na remoção de regras particulares e uso das regras privadas da família. Não alteram o modelo de confirmação, o esquema do banco, a validação de permissões ou a cifra das credenciais. A distribuição não concede acesso administrativo pela escolha do nome de usuário.

## Limites e manutenção

Os dados reais de uma instalação devem continuar fora do Git. O operador precisa configurar contas, segredos, backups e atualizações. Código público não é criptografia ponta a ponta e não elimina risco de comprometimento do servidor. Consulte [SECURITY.md](../SECURITY.md).

Referências: [GitHub — visibilidade e exposição de histórico/logs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility), [Gitleaks](https://github.com/gitleaks/gitleaks), [aviso minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249), [aviso glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4).
