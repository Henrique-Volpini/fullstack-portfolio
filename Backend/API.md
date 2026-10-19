# API HTTP e WebSocket

Os caminhos são relativos ao backend. No desenvolvimento, a base é `http://localhost:8000`. O prefixo `/api` usado pelo proxy do frontend não faz parte dessas rotas. IDs, datas e tokens deste documento são exemplos.

Como as migrations são mantidas apenas localmente, prepare um banco novo executando, nesta ordem, dentro de `Backend/`: `python manage.py makemigrations api`, `python manage.py migrate` e `python manage.py createcachetable`. O último comando cria a tabela usada pelos limites de requisições.

## Autenticação e tipos

Cadastro e login, inclusive pelo Google, são públicos. Os demais endpoints exigem o token retornado pelo login. Cookies de sessão não substituem esse token na API.

```http
Authorization: Token 0123456789abcdef0123456789abcdef01234567
Content-Type: application/json
Accept: application/json
```

- `conversa_id`: UUID em formato de string.
- `id_cliente`: UUID em formato de string, gerado pelo cliente para identificar um envio. Reutilize o mesmo UUID e conteúdo ao repetir uma tentativa.
- `mensagem_id` e `id` de mensagem: inteiros positivos.
- Datas: strings ISO 8601 com fuso horário.
- `destinatario`: `henrique` ou `assistente`.
- `origem`: `usuario`, `henrique` ou `assistente`, determinada pelo servidor.
- `remetente`: objeto com `id` e `nome`. Para respostas de qualquer superusuário, o valor público é sempre `{"id":null,"nome":"Henrique"}`, inclusive na conversa do Assistente. Para a futura IA, será `{"id":null,"nome":"Assistente"}`.

Um usuário comum acessa somente as próprias conversas. Qualquer superusuário ativo acessa todas e responde como Henrique, independentemente do nome de sua conta. A flag `is_staff`, sozinha, não concede esse acesso. O Assistente ainda não gera respostas automáticas.

### Validade do token da API

O token local expira 1 hora após a emissão por padrão. Para configurar outro prazo, defina `DJANGO_TOKEN_TTL_SECONDS` no `Backend/.env` com um inteiro positivo em segundos, por exemplo `DJANGO_TOKEN_TTL_SECONDS=3600`, e reinicie o backend. A configuração é lida em `AUTH_TOKEN_TTL_SECONDS`; valores inválidos impedem a inicialização.

O prazo é absoluto: requisições, pings e novos logins com um token ainda válido não renovam sua emissão nem sua validade. No instante em que `created + prazo` é atingido, o token já está vencido. Tokens existentes também seguem o prazo configurado, contado de sua emissão original.

HTTP rejeita tokens vencidos com `401` e `WWW-Authenticate: Token`. WebSockets recusam a autenticação, comandos e eventos privados com token vencido e encerram com `4401`; uma conexão ociosa também é encerrada automaticamente no vencimento. Ao receber esses resultados, o cliente deve limpar o token local e solicitar novo login.

Os logins por senha e Google reutilizam o token válido ou substituem o vencido. A conta mantém um único token, compartilhado entre dispositivos; logins simultâneos não criam tokens independentes. O formato das respostas de login permanece o mesmo.

## Endpoints HTTP

| Método | Caminho | Token | Sucesso |
| --- | --- | --- | --- |
| POST | `/usuarios/` | Não | 201 |
| POST | `/login/` | Não | 200 |
| POST | `/login/google/` | Não | 200 |
| POST | `/logout/` | Sim | 204 |
| GET | `/chat/` | Sim | 200 |
| GET | `/chat/conversas/` | Sim | 200 |
| POST | `/chat/conversas/` | Sim | 201 ou 200 |
| GET | `/chat/conversas/<conversa_id>/` | Sim | 200 |
| GET | `/chat/conversas/<conversa_id>/mensagens/` | Sim | 200 |
| POST | `/chat/conversas/<conversa_id>/mensagens/` | Sim | 201 ou 200 |
| POST | `/chat/conversas/<conversa_id>/leitura/` | Sim | 200 |

### POST `/usuarios/`

Cria uma conta comum. Não retorna token; depois do cadastro, execute o login.

| Campo | Tipo | Obrigatório | Validação |
| --- | --- | --- | --- |
| `username` | string | Sim | Até 150 caracteres; normalização Unicode NFKC, caracteres permitidos pelo Django e unicidade. |
| `password` | string | Sim | Até 64 caracteres; validações de senha do Django, incluindo mínimo de 8 caracteres. Espaços são preservados. |
| `email` | string | Não | E-mail válido ou string vazia; até 254 caracteres. |

Requisição:

```json
{
  "username": "ana",
  "password": "SenhaForte!93q8z7",
  "email": "ana@example.com"
}
```

Resposta `201`:

```json
{
  "id": 7,
  "username": "ana",
  "email": "ana@example.com"
}
```

A senha nunca é retornada. Sem e-mail informado, `email` retorna `""`. Campos de privilégio, como `is_superuser`, não fazem parte do serializer de cadastro e não concedem permissões. Erros: `400` para dados inválidos/nome ocupado e `429` para limite de tentativas.

### POST `/login/`

Recebe `username` (até 150 caracteres) e `password` (até 64). Ambos são obrigatórios; a senha não é aparada.

Requisição:

```json
{
  "username": "ana",
  "password": "SenhaForte!93q8z7"
}
```

Resposta `200`:

```json
{
  "token": "0123456789abcdef0123456789abcdef01234567",
  "usuario": {
    "id": 7,
    "username": "ana",
    "email": "ana@example.com"
  }
}
```

O token existente da conta é reutilizado enquanto válido, sem renovar o prazo; se estiver vencido, é substituído por um novo token. Credenciais incorretas retornam `401`, com `WWW-Authenticate: Token`:

```json
{
  "erro": "Usuário ou senha incorretos."
}
```

Depois de 5 falhas, o nome de usuário fica bloqueado por 15 minutos, inclusive se a próxima tentativa usar a senha correta ou outro IP. O bloqueio retorna `429`:

```json
{
  "detail": "Login temporariamente bloqueado. Aguarde o desbloqueio automático."
}
```

Dados ausentes/inválidos retornam `400`. O limite geral do endpoint também pode retornar `429`. Falha temporária no banco ao emitir o token retorna `503`; o cliente pode tentar o login novamente.

### POST `/login/google/`

Autentica uma conta Google e cria seu perfil local no primeiro acesso. Configure `GOOGLE_CLIENT_ID` no `Backend/.env` com o Client ID do aplicativo Web autorizado no Google. Não exige Client Secret nem endpoint de callback no backend: o cliente recebe o ID token do Google e o envia nesta requisição.

Após atualizar o backend, execute `python manage.py makemigrations api` e `python manage.py migrate` para criar o vínculo `ContaGoogle` no banco, seguindo a preparação descrita no início deste documento.

Aceita somente `Content-Type: application/json`.

| Campo | Tipo | Obrigatório | Validação |
| --- | --- | --- | --- |
| `credential` | string | Sim | ID token do Google não vazio, com até 8.192 caracteres. |

Requisição:

```json
{
  "credential": "ID_TOKEN_RECEBIDO_DO_GOOGLE"
}
```

O servidor verifica assinatura, expiração, emissor e audiência do token para o `GOOGLE_CLIENT_ID` configurado. Também exige `sub` não vazio com até 255 caracteres, e-mail válido com até 254 caracteres e `email_verified: true`.

O vínculo é identificado exclusivamente pelo `sub` único da conta Google. Não há associação automática com contas locais por e-mail ou nome de usuário. No primeiro acesso, cria um usuário comum com senha inutilizável e nome de usuário aleatório no formato `google_<uuid>`; os nomes fornecidos pelo Google são limitados a 150 caracteres em cada campo. Nos próximos acessos com o mesmo `sub`, reutiliza a conta e seu token local enquanto válido, sem renovar o prazo; se estiver vencido, substitui o token. Contas desativadas não podem entrar.

Resposta `200`, tanto na criação quanto nos acessos seguintes:

```json
{
  "token": "0123456789abcdef0123456789abcdef01234567",
  "usuario": {
    "id": 8,
    "username": "google_98149484b5fb4ae08c5e0216525c5933",
    "email": "ana@example.com"
  }
}
```

Use o `token` retornado pelo Django no cabeçalho `Authorization: Token ...`, inclusive para consultar o perfil em `GET /chat/` e revogar o acesso em `POST /logout/`. O ID token Google não substitui esse token local nem deve ser enviado ao WebSocket.

Erros: `400` para corpo ou `credential` inválido; `401` para credencial Google rejeitada ou conta inativa; `415` para tipo de conteúdo não suportado; `429` para limite de requisições; `503` quando falta `GOOGLE_CLIENT_ID`, a consulta ao Google falha ou excede o timeout de 5 segundos, ou o banco está indisponível. O limite de 20 requisições/minuto por IP é compartilhado com `/login/`; o bloqueio por 5 senhas incorretas descrito no login local não se aplica a esta rota.

No frontend, `VITE_GOOGLE_CLIENT_ID` fica em `Frontend/.env` com o mesmo Client ID público.

### POST `/logout/`

Exige o token no cabeçalho e não recebe corpo. Resposta `204`, sem JSON.

Revoga o token utilizado e notifica os WebSockets desse acesso para encerramento. Como o token é compartilhado pelos logins da conta, a revogação também afeta outros dispositivos que o utilizem. Logout continua permitido quando a cota HTTP do chat está esgotada. Token inválido, ausente ou vencido retorna `401`; nesse caso, o cliente pode apenas limpar a sessão local.

### GET `/chat/`

Não recebe corpo nem parâmetros. Retorna a identidade da própria conta, seu papel e os destinatários disponíveis.

Resposta `200`:

```json
{
  "usuario": {
    "id": 7,
    "username": "ana"
  },
  "operador": false,
  "destinatarios": [
    {
      "id": "henrique",
      "nome": "Henrique"
    },
    {
      "id": "assistente",
      "nome": "Assistente"
    }
  ],
  "assistente_ia_ativo": false,
  "websocket_path": "/ws/chat/"
}
```

`operador` é `true` para qualquer superusuário ativo. `usuario.username` identifica a própria conta conectada; para apresentar o autor de uma mensagem, use `mensagem.remetente.nome`.

### GET `/chat/conversas/`

Lista conversas próprias; para superusuários, lista todas. Ordenação: atualização mais recente primeiro.

| Query string | Tipo | Padrão | Uso |
| --- | --- | --- | --- |
| `page` | inteiro positivo | 1 | Página da listagem. |
| `tamanho` | inteiro positivo | 20 | Itens por página, máximo 100. |
| `destinatario` | string | Sem filtro | `henrique` ou `assistente`. |

```http
GET /chat/conversas/?destinatario=henrique&page=1&tamanho=20
```

Resposta `200`:

```json
{
  "count": 1,
  "next": null,
  "previous": null,
  "results": [
    {
      "id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
      "usuario": {
        "id": 7,
        "username": "ana"
      },
      "destinatario": "henrique",
      "nome_destinatario": "Henrique",
      "criada_em": "2026-10-15T12:00:00-03:00",
      "atualizada_em": "2026-10-15T12:00:00-03:00",
      "nao_lidas": 0,
      "ultima_mensagem": null,
      "ultima_lida_usuario": 0,
      "ultima_lida_henrique": 0
    }
  ]
}
```

`count` é o total após o filtro. `next` e `previous` são URLs completas ou `null`. Cada item tem o mesmo formato retornado no detalhe da conversa. Parâmetro de destinatário inválido retorna `400`; página inexistente retorna `404`.

### POST `/chat/conversas/`

Abre uma conversa com o destinatário. Somente usuários comuns podem executar essa operação; superusuários atendem pelas conversas recebidas.

Requisição:

```json
{
  "destinatario": "henrique"
}
```

Para a outra caixa, envie `{"destinatario":"assistente"}`. Resposta `201` quando criada ou `200` quando a conversa já existe:

```json
{
  "id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "usuario": {
    "id": 7,
    "username": "ana"
  },
  "destinatario": "henrique",
  "nome_destinatario": "Henrique",
  "criada_em": "2026-10-15T12:00:00-03:00",
  "atualizada_em": "2026-10-15T12:00:00-03:00",
  "nao_lidas": 0,
  "ultima_mensagem": null,
  "ultima_lida_usuario": 0,
  "ultima_lida_henrique": 0
}
```

A mesma conta tem no máximo uma conversa por destinatário. O servidor define `usuario`; não envie esse campo. Campos desconhecidos são rejeitados. Erros: `400` para entrada inválida, `403` para superusuário e `503` quando não há superusuário ativo disponível para atendimento.

### GET `/chat/conversas/<conversa_id>/`

Não recebe corpo. Resposta `200`, neste exemplo após uma mensagem do visitante e uma resposta humana:

```json
{
  "id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "usuario": {
    "id": 7,
    "username": "ana"
  },
  "destinatario": "henrique",
  "nome_destinatario": "Henrique",
  "criada_em": "2026-10-15T12:00:00-03:00",
  "atualizada_em": "2026-10-15T12:01:00-03:00",
  "nao_lidas": 1,
  "ultima_mensagem": {
    "id": 102,
    "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
    "remetente": {
      "id": null,
      "nome": "Henrique"
    },
    "origem": "henrique",
    "conteudo": "Olá! Posso ajudar?",
    "id_cliente": "889b3d26-a986-4077-8ae8-a031cb688987",
    "criada_em": "2026-10-15T12:01:00-03:00"
  },
  "ultima_lida_usuario": 0,
  "ultima_lida_henrique": 0
}
```

- `usuario`: dono da conversa, com `id` e `username`.
- `nome_destinatario`: nome público da caixa.
- `ultima_mensagem`: objeto de mensagem completo ou `null`.
- `nao_lidas`: quantidade recebida após o marcador do solicitante. Para o visitante, conta respostas humanas/automáticas; para o atendimento, conta mensagens dos visitantes.
- `ultima_lida_usuario` e `ultima_lida_henrique`: maior ID de mensagem marcado como lido em cada lado; `0` significa nenhum marcador.
- A leitura do lado Henrique é compartilhada entre todos os superusuários.

Conversa inexistente ou sem acesso retorna `404`.

### GET `/chat/conversas/<conversa_id>/mensagens/`

Retorna o histórico sem marcar mensagens como lidas.

| Query string | Tipo | Padrão | Uso |
| --- | --- | --- | --- |
| `cursor` | string | Ausente | Cursor fornecido nas URLs `next`/`previous`. |
| `tamanho` | inteiro positivo | 50 | Mensagens por página, máximo 100. |
| `apos_id` | inteiro entre 0 e 9223372036854775807 | Ausente | Somente mensagens com ID maior que esse valor. |

Sem `apos_id`, a ordem é decrescente por ID, da mais recente para a mais antiga. Com `apos_id`, a ordem é crescente, para recuperar mensagens novas. Resposta `200`:

```json
{
  "next": null,
  "previous": null,
  "results": [
    {
      "id": 102,
      "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
      "remetente": {
        "id": null,
        "nome": "Henrique"
      },
      "origem": "henrique",
      "conteudo": "Olá! Posso ajudar?",
      "id_cliente": "889b3d26-a986-4077-8ae8-a031cb688987",
      "criada_em": "2026-10-15T12:01:00-03:00"
    },
    {
      "id": 101,
      "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
      "remetente": {
        "id": 7,
        "nome": "ana"
      },
      "origem": "usuario",
      "conteudo": "Olá, Henrique.",
      "id_cliente": "da49e725-c65d-4837-95dc-261979322d06",
      "criada_em": "2026-10-15T12:00:00-03:00"
    }
  ]
}
```

Essa paginação não retorna `count`. Siga a URL `next` para continuar e não construa o cursor manualmente. Para recuperar mensagens depois do ID 101:

```http
GET /chat/conversas/49874bb6-1f30-4498-9533-b69f4633cbb5/mensagens/?apos_id=101
```

Resposta `200`:

```json
{
  "next": null,
  "previous": null,
  "results": [
    {
      "id": 102,
      "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
      "remetente": {
        "id": null,
        "nome": "Henrique"
      },
      "origem": "henrique",
      "conteudo": "Olá! Posso ajudar?",
      "id_cliente": "889b3d26-a986-4077-8ae8-a031cb688987",
      "criada_em": "2026-10-15T12:01:00-03:00"
    }
  ]
}
```

Conecte e autentique o WebSocket antes de recuperar o histórico após uma reconexão. Deduplique pelo `id`, pois a mesma mensagem pode chegar pela consulta e pelo evento ao vivo. `apos_id` inválido retorna `400`; cursor inválido ou conversa sem acesso/inexistente retorna `404`.

### POST `/chat/conversas/<conversa_id>/mensagens/`

Envia uma mensagem. O mesmo endpoint é usado por visitante e superusuário.

| Campo | Tipo | Obrigatório | Validação |
| --- | --- | --- | --- |
| `conteudo` | string | Sim | Texto não vazio após remover espaços nas extremidades; até 4.000 caracteres. |
| `id_cliente` | UUID | Sim | Identificador do envio, para reenvio sem duplicação. |

Requisição:

```json
{
  "conteudo": "Olá, Henrique.",
  "id_cliente": "da49e725-c65d-4837-95dc-261979322d06"
}
```

Resposta `201`:

```json
{
  "id": 101,
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "remetente": {
    "id": 7,
    "nome": "ana"
  },
  "origem": "usuario",
  "conteudo": "Olá, Henrique.",
  "id_cliente": "da49e725-c65d-4837-95dc-261979322d06",
  "criada_em": "2026-10-15T12:00:00-03:00"
}
```

Uma resposta humana retorna o mesmo formato, com `origem: "henrique"` e `remetente: {"id":null,"nome":"Henrique"}`, como no exemplo do histórico. A futura IA utilizará `origem: "assistente"` e nome `Assistente`. O cliente não pode definir autoria.

`conteudo` é texto simples, sem interpretação de HTML. O frontend deve renderizá-lo como texto, inclusive quando contiver tags ou trechos de código.

Repetir o mesmo `id_cliente`, conteúdo e remetente na mesma conversa/origem retorna a mensagem original com `200`, sem nova publicação. Reutilizar a chave com outro conteúdo ou outra conta administrativa retorna `409`. A chave é isolada por conversa e origem.

Erros: `400` para texto/UUID inválido ou campos extras; `404` para conversa sem acesso/inexistente; `429` para limite; `503` para indisponibilidade temporária. Uma resposta de sucesso confirma gravação no banco, sem garantir que o destinatário já recebeu ou leu a mensagem.

### POST `/chat/conversas/<conversa_id>/leitura/`

Marca leitura até uma mensagem da própria conversa.

Requisição:

```json
{
  "mensagem_id": 102
}
```

Resposta `200`:

```json
{
  "type": "conversa.lida",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "por": "usuario",
  "mensagem_id": 102
}
```

`por` vale `usuario` para o visitante ou `henrique` para um superusuário. O marcador nunca diminui; a resposta pode conter um ID maior que o solicitado se esse lado já avançou a leitura. Ler o histórico não executa essa operação automaticamente. Entrada inválida retorna `400`; mensagem/conversa sem acesso ou inexistente retorna `404`.

### HEAD e OPTIONS

`HEAD` está disponível nas rotas com `GET`, com os mesmos cabeçalhos e sem corpo de resposta. `OPTIONS` está disponível nas rotas da API; o cabeçalho `Allow` informa os métodos habilitados.

Uma consulta de metadados `OPTIONS /chat/`, autenticada, retorna `200`:

```json
{
  "name": "Chat Inicio",
  "description": "",
  "renders": [
    "application/json",
    "text/html"
  ],
  "parses": [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data"
  ]
}
```

Os metadados variam por endpoint; no cadastro também podem incluir os campos de `POST`. Preflight CORS é processado pelo middleware e não é a mesma consulta de metadados. Métodos de alteração/exclusão não implementados retornam `405` nas rotas existentes.

## Erros HTTP

O formato depende da origem do erro. Validação do corpo normalmente retorna um objeto com listas por campo; validações de query string podem retornar uma lista de mensagens. Erros gerais usam `detail`. A exceção de credenciais incorretas do login usa `erro`, conforme documentado acima. Não dependa do texto localizado para decidir o fluxo; use o status e os campos.

`400`, exemplo de corpo inválido:

```json
{
  "conteudo": [
    "Este campo pode não estar em branco."
  ]
}
```

`401`, exemplo de token ausente:

```json
{
  "detail": "As credenciais de autenticação não foram fornecidas."
}
```

Token inválido ou vencido também retorna `401`, com `WWW-Authenticate: Token`; execute novo login para obter acesso novamente.

`403`, tentativa de superusuário abrir conversa como visitante:

```json
{
  "detail": "Responda pelas conversas recebidas dos usuários."
}
```

`404`, exemplo de conversa inexistente/sem acesso:

```json
{
  "detail": "No Conversa matches the given query."
}
```

`405`, exemplo:

```json
{
  "detail": "Método \"PUT\" não é permitido."
}
```

`409`, chave de envio já utilizada em outra mensagem:

```json
{
  "detail": "Este id_cliente já foi utilizado em outra mensagem."
}
```

`429`, limite de requisições, exemplo com espera de 60 segundos:

```http
Retry-After: 60
```

```json
{
  "detail": "Pedido foi suprimido. Espera-se que esteja diponível em 60 segundos."
}
```

`Retry-After` é fornecido pelo throttling do DRF; o bloqueio de conta pelo Axes tem a resposta própria descrita no login. Textos podem variar com o idioma/versão da biblioteca.

`503`, falha temporária de banco/serviço do chat:

```json
{
  "detail": "O chat está temporariamente indisponível. Tente novamente."
}
```

Quando não há superusuário ativo para atendimento, o `detail` é `"O responsável pelo chat ainda não está disponível."`. Não são retornados detalhes internos de banco ou Redis.

## WebSocket `/ws/chat/`

No desenvolvimento: `ws://localhost:8000/ws/chat/`. Em produção, utilize `wss://` na origem do backend. O cabeçalho `Origin` precisa ser permitido pelo backend; o navegador o envia automaticamente. Clientes de teste precisam enviá-lo explicitamente.

Não envie query string ou token na URL. Cookies não autenticam a conexão: a autenticação ocorre no primeiro comando JSON. Uma conexão autenticada recebe eventos das conversas permitidas; o cliente não escolhe grupos de outros usuários.

### Autenticar

Após aceitar a conexão, o servidor envia:

```json
{
  "type": "autenticacao.necessaria",
  "prazo_segundos": 10
}
```

Em até 10 segundos, o cliente envia:

```json
{
  "type": "autenticar",
  "token": "0123456789abcdef0123456789abcdef01234567"
}
```

Resposta do servidor:

```json
{
  "type": "autenticado",
  "usuario": {
    "id": 7,
    "username": "ana"
  },
  "operador": false
}
```

`operador` é `true` para qualquer superusuário ativo. O objeto `usuario` identifica somente a própria conexão; o autor público das mensagens é informado em `mensagem.remetente`. Token inválido/vencido, conta inativa ou comando antes da autenticação produz erro e encerramento; ausência de autenticação dentro do prazo encerra a conexão.

### Enviar mensagem

Cliente:

```json
{
  "type": "mensagem.enviar",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "conteudo": "Olá, Henrique.",
  "id_cliente": "da49e725-c65d-4837-95dc-261979322d06"
}
```

Confirmação ao socket que enviou:

```json
{
  "type": "mensagem.confirmada",
  "mensagem": {
    "id": 101,
    "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
    "remetente": {
      "id": 7,
      "nome": "ana"
    },
    "origem": "usuario",
    "conteudo": "Olá, Henrique.",
    "id_cliente": "da49e725-c65d-4837-95dc-261979322d06",
    "criada_em": "2026-10-15T12:00:00-03:00"
  },
  "repetida": false
}
```

`repetida` é `true` em um reenvio idêntico. A mensagem e suas validações são as mesmas da API HTTP. Erros relacionados ao comando incluem `id_cliente` e `conversa_id` quando esses valores são válidos.

### Evento de mensagem criada

É entregue ao visitante e aos superusuários ativos, inclusive ao próprio remetente conectado. Também é publicado quando a mensagem foi enviada por HTTP.

```json
{
  "type": "mensagem.criada",
  "mensagem": {
    "id": 101,
    "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
    "remetente": {
      "id": 7,
      "nome": "ana"
    },
    "origem": "usuario",
    "conteudo": "Olá, Henrique.",
    "id_cliente": "da49e725-c65d-4837-95dc-261979322d06",
    "criada_em": "2026-10-15T12:00:00-03:00"
  }
}
```

`mensagem.criada` e `mensagem.confirmada` podem chegar em qualquer ordem. Deduplique pelo ID da mensagem. Um reenvio idêntico produz confirmação sem nova mensagem nem novo evento de criação.

### Marcar leitura

Cliente:

```json
{
  "type": "conversa.ler",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "mensagem_id": 102
}
```

Confirmação ao solicitante:

```json
{
  "type": "leitura.confirmada",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "por": "usuario",
  "mensagem_id": 102
}
```

Quando o marcador avança, visitante e superusuários também recebem:

```json
{
  "type": "conversa.lida",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "por": "usuario",
  "mensagem_id": 102
}
```

As regras de acesso e de avanço do marcador são as mesmas do endpoint HTTP.

### Evento de conversa criada

Publicado quando um usuário abre uma conversa nova por HTTP:

```json
{
  "type": "conversa.criada",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "usuario": {
    "id": 7,
    "username": "ana"
  },
  "destinatario": "henrique"
}
```

Use o ID para consultar os detalhes ou atualizar a listagem. Abrir novamente uma conversa já existente não publica esse evento.

### Ping

Cliente, a cada 30 segundos:

```json
{
  "type": "ping"
}
```

Servidor:

```json
{
  "type": "pong"
}
```

O ping verifica o acesso e renova a participação da conexão no grupo, sem estender a validade do token. Criação/listagem de conversas e consultas de histórico são feitas por HTTP.

### Erros de comandos

Exemplo de conflito em reenvio:

```json
{
  "type": "erro",
  "codigo": "conflito_mensagem",
  "status": 409,
  "erros": "Este id_cliente já foi utilizado em outra mensagem.",
  "comando": "mensagem.enviar",
  "conversa_id": "49874bb6-1f30-4498-9533-b69f4633cbb5",
  "id_cliente": "da49e725-c65d-4837-95dc-261979322d06"
}
```

- `codigo`: código do erro, como `invalid`, `authentication_failed`, `not_found`, `conflito_mensagem`, `throttled` ou `chat_indisponivel`.
- `status`: equivalente ao status HTTP.
- `erros`: string, lista ou objeto de validação.
- `comando`, `conversa_id` e `id_cliente`: presentes quando aplicáveis e válidos.
- `tente_novamente_em`: número de segundos para tentar novamente, presente nos erros de limite de envio.

JSON inválido após autenticação retorna `erro` com status `400` e mantém a conexão. Antes da autenticação, uma entrada inválida encerra o acesso. Texto binário e frames excessivos encerram a conexão.

### Encerramentos

| Código | Motivo |
| --- | --- |
| `1003` | Frame binário não suportado. |
| `1009` | Frame maior que o limite. |
| `1013` | Serviço temporariamente indisponível. |
| `4400` | Query string não permitida. |
| `4401` | Token inválido/revogado/vencido, conta inativa ou prazo de autenticação esgotado. |
| `4403` | Papel da conta mudou; reconecte e autentique novamente. |
| `4429` | Limite de conexões ou frames. |

Rejeições anteriores ao aceite, como origem inválida, query string ou cota de conexões, podem aparecer no navegador como falha de handshake HTTP `403`, sem expor o código de fechamento da aplicação. Falhas de rede podem produzir outros códigos do protocolo.

O token, sua validade, o papel e o acesso à conversa são revalidados nos comandos e antes de entregar eventos privados. A conexão é encerrada automaticamente com `4401` no vencimento do token, mesmo sem comandos ou eventos. Logout notifica as conexões do token revogado para encerramento quando o transporte está disponível.

## Limites e recuperação

| Operação | Limite |
| --- | --- |
| Cadastro | 5 tentativas/hora por IP, incluindo entradas rejeitadas. |
| Login local e Google | 20 requisições/minuto por IP, compartilhadas entre `/login/` e `/login/google/`; somente no login local, 5 falhas de senha bloqueiam o usuário por 15 minutos. |
| HTTP do chat | 120 requisições/minuto por conta; logout não usa essa cota. |
| Envio de mensagem | 60/minuto por conta, somando HTTP, WebSocket e ambas as caixas. |
| Novas conexões WebSocket | 20/minuto por IP informado pelo servidor ASGI. |
| Frames recebidos | 120/minuto por conexão. |
| Conteúdo da mensagem | 4.000 caracteres após aparar extremidades. |
| Frame JSON | 32 KiB. |

Os limites por IP/conta usam o throttling do DRF e podem ter pequenas ultrapassagens em concorrência. A unicidade de conversas e mensagens é garantida pelo banco.

O histórico no banco é a fonte de verdade. Se a conexão cair antes da confirmação, repita o envio com o mesmo `id_cliente` e conteúdo. Ao reconectar, autentique o socket, consulte `mensagens/?apos_id=<ultimo_id_recebido>` até o fim da paginação e deduplique pelo `id`. Para leituras recebidas fora de ordem, mantenha o maior marcador.

Falha de publicação em tempo real não desfaz uma mensagem já gravada. Uma confirmação significa persistência, sem garantir entrega/leitura. A integração automática da IA ainda não é exposta como endpoint.
