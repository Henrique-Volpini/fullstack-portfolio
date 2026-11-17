# Portfólio — Henrique Volpini

Portfólio pessoal para apresentar minha formação, experiência e conhecimentos em desenvolvimento Full-Stack.

Além das informações profissionais, o projeto possui um chat para conversar comigo ou com um assistente sobre o portfólio. A interface é feita em React e a API em Django cuida das contas, das conversas e do banco de dados.

## Implementações

- Página responsiva, adaptada para computador e celular.
- Quatro temas visuais, com a escolha salva no navegador.
- Informações profissionais, links de contato e currículo em PDF.
- Cadastro e login por usuário e senha.
- Login com Google, quando configurado.
- Chat em tempo real, com histórico, mensagens não lidas e confirmação de leitura.
- Área de atendimento para o responsável acompanhar e responder às conversas.
- Reconexão do chat e recuperação de mensagens após falhas de conexão.
- Reenvio de mensagens com controle para evitar registros duplicados.
- Assistente integrado ao Gemini, com respostas automáticas quando a chave da API está configurada.
- Testes automatizados de autenticação, permissões, mensagens e conexões em tempo real.

## Proteções implementadas

- **Tentativas repetidas de senha (força bruta):** limites de requisições e bloqueio temporário após erros consecutivos.
- **Acesso a conversas de outras pessoas:** a API verifica a conta e suas permissões antes de permitir leitura ou envio.
- **Falsificação do autor de uma mensagem:** o servidor determina quem está enviando; o visitante não escolhe sua identidade no pedido.
- **Credenciais Google falsas ou reutilizadas:** verificação da assinatura, da validade e do aplicativo de destino, com controle de uso único da credencial.
- **Execução de scripts nas mensagens (XSS):** o chat exibe mensagens como texto, e a versão de produção restringe as origens de scripts com uma política de conteúdo (CSP).
- **Injeção de comandos no banco (SQL injection):** as consultas usam o ORM do Django, sem montar SQL por concatenação de dados recebidos.
- **Envios excessivos ou grandes demais:** limites de frequência e tamanho nas requisições e nas conexões do chat.
- **Uso de sessões encerradas:** os tokens expiram e são revogados no logout; as conexões do chat também verificam sua validade.
- **Armazenamento de senhas em texto puro:** o cadastro utiliza o mecanismo de hash do Django.

## Tecnologias

- **Interface:** React, TypeScript, CSS e Vite.
- **API:** Python, Django e Django REST Framework.
- **Tempo real:** Django Channels, Daphne e Redis em produção.
- **Banco de dados:** PostgreSQL hospedado no Supabase e SQLite disponível no desenvolvimento local.
- **Integrações:** Google Identity Services e Gemini.

A interface pode ser publicada no GitHub Pages. A API Django e o Redis ficam hospedados no Render. E o Banco está no Supabase.

## Configuração e uso

As instruções para executar o projeto, configurar os serviços e utilizar os endpoints estão em [Backend/API.md](Backend/API.md).
