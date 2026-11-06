# Securo: análise e aplicação ao Entre Nós

Análise estática em 22/10/2026 usando o fluxo da skill Reverse Engineer Anything. Como o projeto fornece o código-fonte completo, a investigação usou leitura e busca no repositório, sem decompilação, instalação de dependências ou execução do aplicativo. Dois escopos independentes examinaram o provedor bancário e a conciliação financeira. Não foram enviados dados familiares ao Securo.

**Fonte:** [securo-finance/securo](https://github.com/securo-finance/securo), commit `0a2e371585be3c7ab3cdf3a28b58c3825794ab9d`. Os links abaixo fixam essa revisão; versões posteriores podem mudar os comportamentos descritos.

## Como funciona

O backend separa adaptadores de provedores, serviços de conexão/importação, detecção de transferências, recorrências e orçamento. A conexão agrega contas remotas em contas internas do workspace; transações do provedor alimentam a conciliação. A autorização de membros limita o workspace em que os serviços operam. São observações do código, não prova de como uma instalação pública está configurada.

## O que aproveitamos como conceito

| Conceito observado | Evidência no Securo | Aplicação própria no Entre Nós |
|---|---|---|
| Conta interna continua existindo quando o provedor muda os IDs | [connection_service.py, 1354–1409](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/connection_service.py#L1354) | Renovação em duas etapas com correspondência explícita das contas; mantém os IDs internos e o histórico. |
| Normalizar direção pelo tipo DEBIT/CREDIT e preservar saldo informado | [pluggy.py, 601–625](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/providers/pluggy.py#L601) | Valor absoluto em centavos mais direção explícita. Pagamento visto no cartão é convertido para as duas partidas corretas. |
| Paginação por cursor no endpoint v2 | [pluggy.py, 570–592](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/providers/pluggy.py#L570) | Endpoint fixo, limites de tempo/páginas/tamanho e rejeição de qualquer cursor já visto. |
| Identificador externo sozinho pode não distinguir todas as linhas | [import_service.py, 1034–1082](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/import_service.py#L1034) | ID dá idempotência de leitura; data, conta, moeda e valor ajudam na revisão de coincidências e extratos antigos. Compras iguais não são unidas silenciosamente. |
| Transferências e pagamentos precisam de ligação entre duas pontas | [transfer_detection_service.py, 315–365](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/transfer_detection_service.py#L315) | Sugere a contraparte; a família confirma e a segunda evidência aponta para o mesmo evento. |
| Separar movimento realizado da previsão recorrente | [recurring_match_service.py, 140–193](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/recurring_match_service.py#L140) e [budget_service.py, 268–360](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/budget_service.py#L268) | Preserva o checklist mensal separado dos lançamentos; não marca uma conta como paga apenas pela coincidência de valor. |

## O que não transportamos

**Atualização bancária forçada.** O adaptador do Securo tenta `PATCH /items/{id}` e trata a rejeição da modalidade pessoal como uma situação de fallback para dados disponíveis ([pluggy.py, 719–764](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/providers/pluggy.py#L719)). O nosso leitor só faz autenticação e GET dos recursos autorizados: nenhum PATCH, token de widget ou operação de pagamento. Isso acompanha a [restrição oficial do Meu Pluggy](https://docs.pluggy.ai/en/docs/guides/meu-pluggy-personal-use).

**Confundir leitura com atualização do banco.** O fluxo consultado pode concluir a sincronização local após uma tentativa de atualização que não trouxe novos dados ([connection_service.py, 2586–2600](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/connection_service.py#L2586)). Mantemos dois horários distintos e alertas de falha. Inferência: isso reduz a chance de o usuário interpretar dados em cache como atualização bancária recente.

**Correspondência automática quando há empate.** O serviço de correspondência usa descrição normalizada, direção, valor e janela de datas; uma seleção determinística pode consumir uma das candidatas indistinguíveis ([transaction_match_service.py, 58–101](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/transaction_match_service.py#L58)). No Entre Nós isso só gera sugestões. O vínculo requer os dados exatos da partida ou uma decisão explícita de movimento distinto; a renovação também exige confirmação de duplicidade.

**Janela incremental como única fonte de verdade.** O adaptador usa um recuo de criação para consultas incrementais ([connection_service.py, 2244–2255](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/services/connection_service.py#L2244)). Aqui cada leitura percorre a janela configurada e disponível, com limites: alterações de linhas antigas são alertas e não reescrevem o livro financeiro. Isso tem custo maior de leitura; volumes que ultrapassem o limite falham sem confirmar um lote parcial.

**Segredo geral como chave de criptografia.** O módulo analisado deriva criptografia de `SECRET_KEY` ([crypto.py, 3–41](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/backend/app/agents/services/crypto.py#L3)). Mantemos uma chave dedicada, obrigatória, com criptografia autenticada e vínculo à pessoa/família. Isso é uma decisão de arquitetura; não afirma que uma implantação do Securo exponha segredos.

## Licença e limites da conclusão

O [LICENSE](https://github.com/securo-finance/securo/blob/0a2e371585be3c7ab3cdf3a28b58c3825794ab9d/LICENSE) identifica AGPLv3, incluindo a seção sobre interação remota em rede. Não copiamos código, componentes ou assets do Securo. As mudanças do Entre Nós foram escritas no próprio núcleo, com seus testes e regras de acesso. Se futuramente houver reutilização direta, será preciso avaliar as obrigações da licença antes de incorporá-la.

Não foi executado o Securo nem verificada sua experiência em iPhone, disponibilidade de conectores, operação de produção ou política efetiva de um serviço hospedado. Investimentos, parcelas e automações que aparecem no código são referências para estudo futuro, não funcionalidades prometidas pela integração atual. A conexão real do Entre Nós também depende das autorizações pessoais e da validação do provedor; os testes atuais são sintéticos.
