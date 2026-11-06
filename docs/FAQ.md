# Perguntas frequentes

### O código público dá acesso às minhas finanças?

O código não contém o banco, arquivos originais, credenciais ou dados de uma instalação em funcionamento. Para usar, cada operador cria sua própria instalação e seus próprios segredos. Publicar código não substitui a segurança do servidor: atualizações, autenticação, configuração correta e backups continuam necessários.

### Posso usar sem conectar bancos ou uma IA externa?

Sim. Planejamento, registros manuais e consultas locais funcionam sem essas integrações. Elas são opcionais e não vêm habilitadas com credenciais de terceiros.

### Onde ficam os dados?

No modo local, em `data/postgres`, no computador que executa o servidor. Na hospedagem, no PostgreSQL escolhido pelo operador. O navegador não recebe a credencial do banco. O banco local não é cifrado em repouso pelo app; o serviço não oferece criptografia ponta a ponta.

### Os membros do casal veem a mesma coisa?

As finanças são compartilhadas dentro da família. Tema, foto, disposição de cards e conversas da Judite são individuais. Outra família não recebe acesso por compartilhar a mesma instalação. O administrador de infraestrutura continua tendo responsabilidade e capacidade técnica de acesso ao banco.

### O cadastro é aberto?

Não. Há configuração inicial do primeiro espaço e cadastro controlado de outras famílias pelo administrador designado. Ser proprietário de uma família não concede administração da instalação. O limite atual é de 30 usuários no total.

### Por que uma transferência não aumenta minhas entradas?

Ela muda a localização do mesmo dinheiro. Pagamento de fatura quita a obrigação; as compras representam o consumo. O app evita somar ambos como se fossem duas despesas. Movimentos sem comprovação ficam a conferir.

### Preciso importar um extrato todo mês?

Não. O uso principal é planejar e acompanhar o mês, registrando os imprevistos. Uma importação pode servir para o histórico inicial. A integração de leitura pode auxiliar, mas sua disponibilidade depende do banco e do provedor.

### A conexão com Meu Pluggy é gratuita e ilimitada?

O projeto não garante gratuidade, quantidade de conexões ou cobertura de bancos. Confira as condições atuais do provedor. O fluxo disponível é pessoal, com credenciais próprias de cada titular, cifradas no servidor. Não há aplicação central compartilhada fornecida por este repositório. Nunca envie segredos em issues ou prints.

### A Judite vê todos os meus documentos?

A recuperação histórica usa fatos estruturados autorizados da família, com distinção entre previsão e confirmação. Ela não recebe automaticamente os PDFs, senhas ou credenciais bancárias. Ao ativar um provedor externo, mensagens e o contexto indicado na tela são enviados a esse provedor. Leia suas condições de privacidade e retenção antes de habilitar.

### Posso confiar cegamente na resposta da IA?

Não. Dados incompletos limitam as conclusões e modelos podem errar. Confira fontes, períodos e valores. Uma alteração precisa da confirmação da prévia; uma mensagem no histórico não comprova gravação.

### O app mostra o valor atual de mercado dos investimentos?

As posições e movimentações disponíveis não garantem cotação, rentabilidade ou patrimônio líquido em tempo real. Valores desconhecidos permanecem desconhecidos.

### As notificações funcionam no iPhone?

Web Push exige iOS/iPadOS 16.4 ou posterior, app instalado na Tela de Início e permissão dada por toque. Ative e teste em cada aparelho. No Android e desktop também dependem das permissões do navegador/sistema. Foco, bateria, conexão e o serviço de push podem afetar a entrega. Não é um alarme com precisão de minuto.

### Posso usar offline?

É necessária conexão com o servidor para consultar ou alterar finanças. O service worker guarda somente ativos públicos de instalação e uma tela offline; não mantém um banco financeiro no cache.

### O ícone antigo continua na Tela de Início. O que faço?

Abra o endereço atualizado. Se o sistema mantiver o ícone anterior, remova somente o atalho e adicione novamente pelo navegador. Os dados ficam no servidor; excluir o atalho não apaga o banco. Guarde seu acesso antes de reinstalar.

### Posso hospedar sem pagar?

É possível avaliar planos gratuitos de provedores compatíveis, respeitando suas regras e cotas. Não há garantia de gratuidade permanente, disponibilidade ou cobertura de todos os usos. O repositório não contrata serviços nem inclui contas compartilhadas.

### Como relato um problema?

Abra uma issue com passos de reprodução e dados fictícios. Para vulnerabilidades, use o canal privado indicado em [SECURITY.md](../SECURITY.md). Não publique extratos, fotos pessoais, CPF, senhas, tokens ou strings de conexão.
