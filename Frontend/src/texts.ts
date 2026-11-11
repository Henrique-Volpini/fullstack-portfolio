// Todos os textos que o visitante lê ou ouve no site, reunidos aqui para facilitar a tradução para outros idiomas.
// Links, e-mail, telefone e nomes de usuário continuam no código, porque não mudam com o idioma.
// Funções recebem as partes variáveis da frase, já que a ordem das palavras muda entre idiomas.
export const texts = {
  // Idioma do site: vai para o html, para o formato das datas e para o botão do Google.
  locale: "pt-BR",

  // Título da aba e prévia do link em WhatsApp, LinkedIn e buscadores; o vite.config.ts insere no index.html.
  meta: {
    title: "Henrique Volpini",
    shareTitle: "Henrique Volpini · Full-stack developer",
    description:
      "Henrique Volpini, desenvolvedor full-stack: aplicações web completas, da arquitetura à interface, com Python, Django, Django REST Framework e TypeScript.",
    shareImageAlt: "Cartão com o nome de Henrique Volpini, o cargo full-stack developer e sua foto.",
    ogLocale: "pt_BR",
  },

  // Cabeçalho fixo e navegação.
  header: {
    navLabel: "Navegação principal",
    logo: "Henrique Volpini",
    logoLabel: "Ir para o início",
    links: {
      inicio: "Início",
      about: "Sobre",
      stack: "Stack",
      contato: "Contato",
    },
  },

  // Botão de tema.
  theme: {
    names: {
      noite: "Azul-noite",
      cianotipo: "Cianótipo",
      prancheta: "Prancheta",
      anil: "Anil",
    },
    label: (current: string, next: string) => `Tema ${current}. Mudar para ${next}`,
    title: (next: string) => `Mudar para ${next}`,
  },

  // Apresentação no topo da página.
  hero: {
    eyebrow: "Full-stack developer",
    firstName: "Henrique",
    lastName: "Volpini",
    description: "Desenvolvendo aplicações web completas, da arquitetura à interface.",
    technologies: ["Django", "Django REST", "TypeScript", "Python"],
    photoAlt: "Retrato de Henrique Volpini",
  },

  // Seção Sobre mim e suas abas.
  about: {
    eyebrow: "About",
    title: "Sobre mim",
    tabsLabel: "Tópicos sobre mim",
    companyLogoAlt: "Banestes - Banco do Estado do Espírito Santo",
    companyCaption: "Experiência atual",
    sections: {
      profile: {
        label: "Perfil",
        paragraphs: [
          "Sou estudante de Ciência da Computação na FAESA e atualmente estagiário no Banestes, onde tenho contato direto com o ambiente de tecnologia e com problemas reais do dia a dia de TI.",
          "Tenho interesse principalmente em desenvolvimento Full-Stack, trabalhando com Python, Django, Django REST Framework, TypeScript e JavaScript para construir aplicações web e APIs.",
          "Também utilizo programação para automatizar processos e reduzir tarefas repetitivas, com ferramentas como Python, Power Automate e Excel voltadas à automação e otimização de atividades.",
          "Além do desenvolvimento web, tenho interesse em arquitetura de software, inteligência artificial, desenvolvimento de jogos e novas tecnologias. Parte do meu aprendizado acontece em projetos pessoais, nos quais estudo ferramentas e transformo ideias em aplicações.",
        ],
        details: [
          { term: "Formação", description: "Ciência da Computação — FAESA" },
          { term: "Atualmente", description: "Estagiário — Banestes" },
          { term: "Foco", description: "Desenvolvimento Full-Stack" },
          { term: "Base", description: "Python / Django / TypeScript" },
        ],
      },
      education: {
        label: "Formação",
        paragraphs: [
          "Ingressei no curso de Ciência da Computação na FAESA no início de 2022 e atualmente estou na etapa final da graduação.",
          "Ao longo do curso, tive contato com Python e Java e desenvolvi uma base em algoritmos, estruturas de dados, orientação a objetos, bancos de dados e engenharia de software.",
          "A formação também me apresentou fundamentos de redes, sistemas operacionais e arquitetura de computadores, ajudando a entender como as diferentes partes de um sistema se conectam.",
          "Procuro levar esses conceitos para a prática em projetos pessoais e no trabalho, usando o desenvolvimento de software como forma de consolidar o aprendizado.",
        ],
        details: [
          { term: "Início", description: "2022" },
          { term: "Curso", description: "Ciência da Computação" },
          { term: "Instituição", description: "FAESA" },
          { term: "Situação", description: "Em fase de conclusão" },
        ],
      },
      work: {
        label: "Trabalho atual",
        paragraphs: [
          "No Banestes, atuo como estagiário de desenvolvimento Full-Stack, utilizando Django como principal ferramenta no dia a dia.",
          "Trabalho no desenvolvimento de um site de uso interno criado para facilitar a integração entre grupos e tornar o acesso e o uso das informações mais diretos.",
          "A rotina envolve tanto o backend quanto a interface da aplicação, com uso cotidiano de Django, JavaScript, HTML e CSS.",
          "Essa experiência me permite aprender a partir de necessidades reais, entender melhor a organização de uma aplicação e buscar formas mais simples de apoiar processos internos com software.",
        ],
        details: [
          { term: "Empresa", description: "Banestes" },
          { term: "Função", description: "Estagiário de desenvolvimento Full-Stack" },
          { term: "Principal ferramenta", description: "Django" },
          { term: "Produto", description: "Aplicação web interna" },
        ],
      },
      focus: {
        label: "Foco",
        paragraphs: [
          "Meu foco atual é desenvolvimento Full-Stack: entender o problema, estruturar o backend e construir uma interface clara para quem vai utilizar a aplicação.",
          "Tenho buscado evoluir principalmente em Python, Django, APIs, TypeScript e arquitetura de software, conectando esses conhecimentos em aplicações completas.",
          "Também mantenho interesse em automação, inteligência artificial, desenvolvimento de jogos e novas tecnologias como caminhos complementares de estudo.",
        ],
        details: [
          { term: "Área", description: "Desenvolvimento Full-Stack" },
          { term: "Backend", description: "Python / Django / APIs" },
          { term: "Frontend", description: "TypeScript / JavaScript" },
          { term: "Objetivo", description: "Construir aplicações completas" },
        ],
      },
    },
  },

  // Seção Stack.
  stack: {
    title: "Stack",
    technologies: [
      {
        name: "Python",
        description:
          "Minha base para backend e automações. Comecei na graduação e continuei praticando no trabalho e em projetos pessoais.",
      },
      {
        name: "Django",
        description:
          "Minha principal ferramenta no Banestes, utilizada cotidianamente no desenvolvimento da aplicação web interna.",
      },
      {
        name: "Django REST Framework",
        description:
          "Biblioteca escolhida e já instalada neste portfólio para estruturar a API que conectará o backend Django ao frontend.",
      },
      {
        name: "TypeScript",
        description:
          "Utilizado no frontend deste portfólio para escrever componentes React com tipos mais seguros.",
      },
      {
        name: "JavaScript",
        description:
          "Usado cotidianamente no Banestes para implementar comportamentos e interações na interface da aplicação interna.",
      },
      {
        name: "HTML",
        description:
          "Usado cotidianamente no trabalho para estruturar as páginas e organizar o conteúdo da aplicação.",
      },
      {
        name: "CSS",
        description:
          "Usado cotidianamente no trabalho para construir layouts, responsividade e a apresentação visual das interfaces.",
      },
    ],
  },

  // Seção Contato e os rótulos de cada link.
  contact: {
    title: "Contato",
    eyebrow: "Vamos conversar",
    heading: "Links diretos, sem formulário.",
    description: "Escolha o canal mais conveniente ou baixe a versão provisória do meu currículo.",
    github: {
      kind: "GitHub",
      label: "GitHub de Henrique Volpini (abre em nova aba)",
      copy: "Copiar link do GitHub",
    },
    linkedin: {
      kind: "LinkedIn",
      label: "LinkedIn de Henrique Volpini Gonçalves (abre em nova aba)",
      copy: "Copiar link do LinkedIn",
    },
    whatsapp: {
      kind: "WhatsApp",
      label: "Conversar com Henrique pelo WhatsApp no número mais 55 27 99789 9584 (abre em nova aba)",
      copy: "Copiar link do WhatsApp",
    },
    email: {
      kind: "E-mail",
      label: "Enviar e-mail para Henrique em henriquev.comp@gmail.com",
      copy: "Copiar e-mail",
    },
    resume: {
      kind: "Currículo",
      action: "Baixar PDF",
      copy: "Copiar link do currículo",
    },
  },

  // Botão de copiar dos links de contato.
  copyLink: {
    copiedTitle: "Copiado!",
    copiedStatus: "Copiado",
  },

  // Rodapé.
  footer: {
    copyright: (year: number) => `© ${year} Henrique Volpini`,
  },

  // Diálogo de privacidade.
  privacy: {
    open: "Privacidade",
    title: "Privacidade",
    close: "Fechar privacidade",
    contact: "Contato",
    items: [
      {
        term: "Dados que guardo",
        text: "Usuário, senha (guardada de forma protegida), e-mail se você informar e as mensagens do chat. No login com Google, recebo e-mail, nome e identificador da conta, nunca a senha. Nos logins também registro o IP e o navegador, só para barrar abusos. Uso tudo apenas para você entrar e conversar.",
      },
      {
        term: "Assistente e Google",
        text: "Sua mensagem ao assistente e as mais recentes dessa conversa (até 12 no total) são enviadas ao Google, pela API Gemini, para escolher qual informação do portfólio responder. Conversas diretas comigo não passam pelo Google. Evite escrever dados pessoais ao assistente.",
      },
      {
        term: "No seu navegador",
        text: "O tema escolhido fica no navegador até você limpar os dados do site. Depois do login, um código de acesso temporário vale só para a aba aberta e some quando você sai ou a fecha. Não uso cookies nem análise de visitas; o botão de login do Google carrega um script do Google, com a política dele.",
      },
      {
        term: "Prazo e exclusão",
        text: "Os dados ficam guardados enquanto a conta existir; não há apagamento automático. Para excluir sua conta e todas as mensagens, peça por e-mail.",
      },
    ],
  },

  // Painel de acesso: prévia, login, cadastro e mensagens de erro.
  auth: {
    panelLabel: "Chat",
    miniPanelLabel: "Conversa",
    preview: {
      label: "CONVERSA",
      expired: "Sua sessão expirou. Entre de novo para continuar.",
      open: "Criar conta / Login",
      // Situação do servidor segundo o /servidor/.
      serverDown: "Servidor está sendo atualizado.",
      serverDownButton: "Servidor em atualização",
      serverOk: "Venha testar nossa API! Temos chat com o proprietário e com o Assistente de IA.",
    },
    dialogLabel: "ACESSO",
    close: "Fechar janela de login e cadastro",
    tabsLabel: "Escolha entre login e cadastro",
    login: {
      title: "Entre para conversar.",
      description: "Entre na sua conta para começar a conversa.",
      tab: "Fazer login",
      submit: "Entrar",
      submitting: "Entrando…",
      wait: "Aguarde, estamos confirmando seu acesso…",
    },
    signup: {
      title: "Crie sua conta.",
      description: "Escolha um usuário e uma senha para começar.",
      tab: "Criar conta",
      submit: "Criar conta",
      submitting: "Criando conta…",
      wait: "Aguarde, estamos criando sua conta…",
    },
    fields: {
      username: "Nome de usuário",
      usernamePlaceholder: "Seu usuário",
      password: "Senha",
      passwordPlaceholder: "Sua senha",
      email: "E-mail",
      optional: "(opcional)",
      emailPlaceholder: "voce@exemplo.com",
    },
    // Prefixo de cada erro de campo devolvido pela API.
    fieldErrorPrefixes: {
      username: "Nome de usuário: ",
      email: "E-mail: ",
      password: "Senha: ",
    },
    sessionExpired: "Sua sessão expirou. Entre novamente para continuar.",
    missingFields: "Preencha o nome de usuário e a senha.",
    serverUnavailable: "O servidor está indisponível. Tente novamente em instantes.",
    requestFailed: "Não foi possível concluir a solicitação. Tente novamente.",
    requestFailedShort: "Não foi possível concluir a solicitação.",
    invalidResponse: "O servidor retornou uma resposta inválida. Tente novamente.",
    loginNotConfirmed: "O servidor não confirmou o login. Tente novamente.",
    timeout: "O servidor demorou para responder. Tente novamente.",
    offline: "Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.",
    accountCreatedLoginFailed: (reason: string) =>
      `Sua conta foi criada, mas o login automático não foi concluído. ${reason} Faça login para continuar.`,
    maybeCreated: (reason: string) => `${reason} Se a conta já tiver sido criada, tente fazer login.`,
    logoutNotConfirmed:
      "Você saiu deste navegador, mas o servidor não confirmou a revogação da sessão. Uma cópia do seu token ainda pode funcionar até a sessão expirar.",
    // Login com Google.
    google: {
      loading: "Carregando o login do Google…",
      loadFailed: "Não foi possível carregar o login do Google.",
      retry: "Tentar de novo",
      divider: "ou",
      wait: "Aguarde, estamos confirmando seu acesso com o Google…",
      missingCredential: "Não foi possível obter a credencial do Google. Tente novamente.",
      rejected: "O Google não confirmou seu acesso. Tente novamente.",
      tooManyAttemptsIn: (seconds: number) => `Muitas tentativas de login. Tente de novo em ${seconds} s.`,
      tooManyAttempts: "Muitas tentativas de login. Aguarde um instante e tente de novo.",
      unavailable: "O login com Google está indisponível no momento. Tente novamente em instantes.",
      invalidCredential: "Não foi possível validar a credencial do Google. Tente novamente.",
      failed: "Não foi possível entrar com o Google. Tente novamente.",
      failedShort: "Não foi possível entrar com o Google.",
    },
  },

  // Chat do visitante e caixa de entrada do Henrique.
  chat: {
    label: "CONVERSA",
    operatorLabel: "ATENDIMENTO",
    conversation: "Conversa",
    inbox: "Caixa de entrada",
    inboxTitle: "Caixa de entrada.",
    visitor: "visitante",
    // Nomes usados quando o servidor não envia os destinatários.
    recipients: {
      henrique: "Henrique",
      assistente: "Assistente",
    },
    // Nome do destinatário dentro de uma frase, com artigo quando o idioma pede.
    recipientInSentence: (id: string, name: string) => `${id === "assistente" ? "o " : ""}${name}`,
    visitorTitle: (recipient: string) => `Converse com ${recipient}.`,
    recipientTabsLabel: "Escolha com quem conversar",
    filterLabel: "Filtrar conversas",
    filterAll: "Todas",
    unread: (count: number) => `${count} não lidas`,
    link: {
      live: "Ao vivo",
      connecting: "Conectando",
      polling: "Atualizando",
    },
    today: "Hoje",
    yesterday: "Ontem",
    restore: "Restaurar conversa",
    minimize: "Minimizar conversa",
    expand: "Abrir conversa em tela cheia",
    close: "Fechar janela de conversa",
    logout: "SAIR",
    loggingOut: "SAINDO…",
    retry: "TENTAR DE NOVO",
    threadLabel: (recipient: string) => `Conversa com ${recipient}`,
    backLabel: "Voltar para a caixa de entrada",
    assistantNote:
      "O Assistente ainda não responde sozinho. Sua mensagem fica registrada e o Henrique pode responder por aqui.",
    loading: "Carregando…",
    olderMessages: "Mensagens anteriores",
    empty: "Nenhuma mensagem ainda.",
    emptyOperatorHint: "Aguardando a primeira mensagem.",
    emptyVisitorHint: (recipient: string) => `Diga olá para ${recipient}.`,
    jumpToLatest: "Mais recentes",
    operatorHint: "Respondendo como Henrique",
    replyPlaceholder: "Escreva uma resposta",
    messagePlaceholder: (recipient: string) => `Mensagem para ${recipient}`,
    messageLabel: "Mensagem",
    send: "Enviar mensagem",
    sending: "Enviando…",
    assistantReplying: "Assistente respondendo…",
    notSent: "Não enviada.",
    retryMessage: "Tentar de novo",
    discard: "Descartar",
    seen: "Visto",
    noConversations: "Nenhuma conversa por aqui.",
    noConversationsHint: "As mensagens dos visitantes aparecem nesta lista.",
    previewFromAssistant: "Assistente: ",
    previewFromMe: "Você: ",
    moreConversations: "Ver mais conversas",
    unavailableTitle: "Conversa indisponível.",
    crashed: "O chat encontrou um erro inesperado. O restante do site continua funcionando normalmente.",
    // Erros da comunicação com a API do chat.
    errors: {
      sessionExpired: "Sua sessão expirou. Entre novamente.",
      invalidMessage: "A mensagem não pode ficar vazia nem passar de 4.000 caracteres.",
      badRequest: "Não foi possível processar a solicitação.",
      forbidden: "Ação não permitida.",
      notFound: "Conversa não encontrada.",
      conflict: "Esta mensagem já foi enviada com outro conteúdo.",
      tooManyRequestsIn: (seconds: number) => `Muitas requisições. Tente de novo em ${seconds} s.`,
      tooManyRequests: "Muitas requisições. Aguarde um instante e tente de novo.",
      unavailable: "O chat está temporariamente indisponível. Tente novamente.",
      failed: "Não foi possível concluir a solicitação.",
      timeout: "O servidor demorou para responder.",
      offline: "Sem conexão com o servidor.",
      invalidResponse: "O servidor retornou uma resposta inválida.",
      needsReload: "A conversa precisa ser recarregada.",
    },
  },
};
