import {
  ApiError,
  abrirConversa,
  encerrarSessao,
  enviarMensagem,
  getConversa,
  getMensagens,
  getPerfil,
  isMensagem,
  listConversas,
  marcarLida,
  novoUuid,
  socketUrl,
  type Conversa,
  type Destinatario,
  type Mensagem,
  type Perfil,
} from "./chatApi";

// Filtro da lista de conversas do operador.
export type Filtro = "todas" | Destinatario;
// Mensagem na interface: pode estar enviando ou ter falhado.
export type UiMessage = Mensagem & { status?: "enviando" | "falhou"; erro?: string };

// Histórico carregado de uma conversa, com paginação e último id sincronizado.
export type Thread = {
  messages: UiMessage[];
  phase: "loading" | "ready" | "error";
  error: string | null;
  olderNext: string | null;
  loadingOlder: boolean;
  syncedId: number;
};

// Estado completo do chat: perfil, conexão, conversas, históricos e erros.
export type ChatState = {
  phase: "loading" | "ready" | "error";
  error: string | null;
  profile: Perfil | null;
  link: "connecting" | "live" | "polling";
  conversations: Record<string, Conversa>;
  threads: Record<string, Thread>;
  listNext: Partial<Record<Filtro, string | null>>;
  listLoading: Partial<Record<Filtro, boolean>>;
  listError: Partial<Record<Filtro, string>>;
  inboxErrors: Partial<Record<Destinatario, string>>;
};

const initialState: ChatState = {
  phase: "loading",
  error: null,
  profile: null,
  link: "connecting",
  conversations: {},
  threads: {},
  listNext: {},
  listLoading: {},
  listError: {},
  inboxErrors: {},
};

const PAGE_SIZE = 30;
const POLL_MS = 5000;
const PING_MS = 30000;
const RECONCILE_MS = 60000;
const MAX_CATCH_UP_PAGES = 30;
const MAX_READ_ATTEMPTS = 3;

// Mescla mensagens confirmadas e novas por id, mantendo as pendentes locais no fim.
export function mergeMessages(current: UiMessage[], incoming: Mensagem[]): UiMessage[] {
  const confirmed = new Map<number, UiMessage>();
  const pending: UiMessage[] = [];

  for (const message of current) {
    if (message.status) pending.push(message);
    else confirmed.set(message.id, message);
  }
  for (const message of incoming) confirmed.set(message.id, message);

  const clientIds = new Set(Array.from(confirmed.values(), (message) => message.id_cliente));
  return [
    ...Array.from(confirmed.values()).sort((a, b) => a.id - b.id),
    ...pending.filter((message) => !clientIds.has(message.id_cliente)),
  ];
}

// Maior id entre as mensagens já confirmadas pelo servidor.
export function lastConfirmedId(messages: UiMessage[]): number {
  return messages.reduce((highest, message) => (message.status ? highest : Math.max(highest, message.id)), 0);
}

// Conversas com mensagem, filtradas e da mais recente para a mais antiga.
export function inboxItems(conversations: Record<string, Conversa>, filter: Filtro): Conversa[] {
  return Object.values(conversations)
    .filter((item) => item.ultima_mensagem && (filter === "todas" || item.destinatario === filter))
    .sort((a, b) => Date.parse(b.atualizada_em) - Date.parse(a.atualizada_em));
}

// Soma das mensagens não lidas de todas as conversas.
export function totalUnread(state: ChatState): number {
  return Object.values(state.conversations).reduce((sum, conversation) => sum + conversation.nao_lidas, 0);
}

// Mensagem de erro segura para exibir ao usuário.
function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Não foi possível concluir a solicitação.";
}

// Leituras otimistas em voo: requisições, não lidas de antes da primeira e maior id que falhou.
type PendingRead = { requests: number; unread: number; failedTop: number };

// Devolve a mais recente entre duas datas ISO.
function newerDate(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

// Store do chat: guarda o estado e cuida da API, do WebSocket, da sincronização e das leituras.
export class ChatStore {
  private token: string;
  private state: ChatState = initialState;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private socket: WebSocket | null = null;
  private attempts = 0;
  private reconnectTimer = 0;
  private pollTimer = 0;
  private pingTimer = 0;
  private authTimer = 0;
  private reconcileTimer = 0;
  private readTimers = new Map<string, number>();
  private readAttempts = new Map<string, number>();
  private confirmedReads = new Map<string, number>();
  private pendingReads = new Map<string, PendingRead>();
  private listInFlight = new Set<string>();
  private fullSyncQueued = false;
  private opening = new Map<Destinatario, Promise<string | null>>();
  private deliveries = new Map<string, Promise<void>>();
  private viewing: string | null = null;
  private filter: Filtro = "todas";
  private syncing = false;
  private started = false;
  private onSessionExpired: () => void = () => {};

  // Cria a store com o token de acesso do usuário.
  constructor(token: string) {
    this.token = token;
  }

  // Registra um ouvinte de mudanças e devolve a função que o remove.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Devolve o estado atual.
  getState = () => this.state;

  // Define o callback chamado quando a sessão expira.
  setHandlers(handlers: { onSessionExpired: () => void }) {
    this.onSessionExpired = handlers.onSessionExpired;
  }

  // Inicia a store: carrega perfil e conversas e abre a conexão em tempo real.
  start() {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.set({ ...initialState });
    void this.bootstrap();
  }

  // Encerra requisições, conexão e temporizadores e limpa o estado interno.
  stop() {
    this.started = false;
    this.abort?.abort();
    this.abort = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.closeSocket();
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.pollTimer);
    this.pollTimer = 0;
    window.clearInterval(this.reconcileTimer);
    this.readTimers.forEach((timer) => window.clearTimeout(timer));
    this.readTimers.clear();
    this.readAttempts.clear();
    this.confirmedReads.clear();
    this.pendingReads.clear();
    this.listInFlight.clear();
    this.opening.clear();
    this.deliveries.clear();
    this.syncing = false;
    this.fullSyncQueued = false;
    this.attempts = 0;
    this.viewing = null;
  }

  // Recarrega perfil e conversas depois de um erro.
  reload() {
    if (this.started && this.state.phase !== "loading") void this.bootstrap();
  }

  // Remove o erro de abertura da caixa de entrada de um destinatário.
  clearInboxError(destinatario: Destinatario) {
    this.set((state) => ({ inboxErrors: { ...state.inboxErrors, [destinatario]: undefined } }));
  }

  // Encerra a conexão local e informa se o servidor confirmou a revogação do token.
  logout(): Promise<boolean> {
    this.stop();
    return encerrarSessao(this.token);
  }

  // Define a conversa em exibição, carrega seu histórico e agenda a leitura.
  setViewing(conversationId: string | null) {
    if (this.viewing === conversationId) return;
    this.viewing = conversationId;
    if (!conversationId) return;
    void this.ensureThread(conversationId);
    this.queueRead(conversationId);
  }

  // Carrega a lista de conversas (ou a próxima página) e mescla no estado.
  async loadList(filter: Filtro, more = false) {
    const signal = this.abort?.signal;
    const cursor = more ? this.state.listNext[filter] : undefined;
    if (!more) this.filter = filter;

    const key = `${filter}:${more}`;
    if (!signal || (more && !cursor) || this.listInFlight.has(key)) return;

    this.listInFlight.add(key);
    this.set((state) => ({
      listLoading: { ...state.listLoading, [filter]: true },
      listError: { ...state.listError, [filter]: undefined },
    }));
    try {
      const page = await listConversas(this.token, {
        destinatario: filter === "todas" ? undefined : filter,
        next: cursor,
        signal,
      });
      this.set((state) => {
        const last = page.results[page.results.length - 1];
        const moveCursor = more
          ? state.listNext[filter] === cursor
          : state.listNext[filter] === undefined || (!!page.next && !!last && !state.conversations[last.id]);
        return {
          conversations: this.mergeConversations(state.conversations, page.results),
          listNext: moveCursor ? { ...state.listNext, [filter]: page.next } : state.listNext,
        };
      });
    } catch (error) {
      if (!this.handleFailure(error, signal)) {
        this.set((state) => ({ listError: { ...state.listError, [filter]: messageOf(error) } }));
      }
    } finally {
      this.listInFlight.delete(key);
      const busy = this.listInFlight.has(`${filter}:true`) || this.listInFlight.has(`${filter}:false`);
      this.set((state) => ({ listLoading: { ...state.listLoading, [filter]: busy } }));
    }
  }

  // Devolve o id da conversa com o destinatário, criando-a uma única vez se necessário.
  openInbox(destinatario: Destinatario): Promise<string | null> {
    const existing = Object.values(this.state.conversations).find(
      (conversation) => conversation.destinatario === destinatario,
    );
    if (existing) return Promise.resolve(existing.id);

    let pending = this.opening.get(destinatario);
    if (!pending) {
      pending = this.createInbox(destinatario).finally(() => this.opening.delete(destinatario));
      this.opening.set(destinatario, pending);
    }
    return pending;
  }

  // Carrega a primeira página do histórico se ainda não foi carregada ou se houve erro.
  async ensureThread(conversationId: string) {
    const signal = this.abort?.signal;
    const existing = this.state.threads[conversationId];
    if (!signal || (existing && existing.phase !== "error")) return;

    this.updateThread(conversationId, (thread) => ({ ...thread, phase: "loading", error: null }));
    try {
      const page = await getMensagens(this.token, conversationId, { tamanho: PAGE_SIZE, signal });
      const highest = page.results.reduce((top, message) => Math.max(top, message.id), 0);
      this.updateThread(conversationId, (thread) => ({
        ...thread,
        messages: mergeMessages(thread.messages, page.results),
        phase: "ready",
        error: null,
        olderNext: page.next,
        syncedId: Math.max(thread.syncedId, highest),
      }));
      if (this.viewing === conversationId) this.queueRead(conversationId);
    } catch (error) {
      if (this.handleFailure(error, signal)) return;
      this.updateThread(conversationId, (thread) => ({ ...thread, phase: "error", error: messageOf(error) }));
    }
  }

  // Carrega a página de mensagens anteriores.
  async loadOlder(conversationId: string) {
    const signal = this.abort?.signal;
    const thread = this.state.threads[conversationId];
    if (!signal || !thread?.olderNext || thread.loadingOlder) return;

    this.updateThread(conversationId, (current) => ({ ...current, loadingOlder: true }));
    try {
      const page = await getMensagens(this.token, conversationId, { next: thread.olderNext, signal });
      this.updateThread(conversationId, (current) => ({
        ...current,
        messages: mergeMessages(current.messages, page.results),
        olderNext: page.next,
        loadingOlder: false,
      }));
    } catch (error) {
      this.updateThread(conversationId, (current) => ({ ...current, loadingOlder: false }));
      this.handleFailure(error, signal);
    }
  }

  // Mostra a mensagem como pendente na tela e a coloca na fila de envio.
  send(conversationId: string, text: string) {
    const content = text.trim();
    const profile = this.state.profile;
    if (!content || !profile) return;

    const pending: UiMessage = {
      id: 0,
      conversa_id: conversationId,
      remetente: profile.operador
        ? { id: null, nome: "Henrique" }
        : { id: profile.usuario.id, nome: profile.usuario.username },
      origem: profile.operador ? "henrique" : "usuario",
      conteudo: content,
      id_cliente: novoUuid(),
      criada_em: new Date().toISOString(),
      status: "enviando",
    };

    this.updateThread(conversationId, (thread) => ({ ...thread, messages: [...thread.messages, pending] }));
    this.enqueue(pending);
  }

  // Reenvia uma mensagem que falhou.
  retry(conversationId: string, clientId: string) {
    const message = this.state.threads[conversationId]?.messages.find(
      (item) => item.status === "falhou" && item.id_cliente === clientId,
    );
    if (!message) return;

    const retrying: UiMessage = { ...message, status: "enviando", erro: undefined };
    this.replacePending(conversationId, clientId, retrying);
    this.enqueue(retrying);
  }

  // Descarta uma mensagem pendente ou que falhou.
  discard(conversationId: string, clientId: string) {
    this.updateThread(conversationId, (thread) => ({
      ...thread,
      messages: thread.messages.filter((item) => !(item.status && item.id_cliente === clientId)),
    }));
  }

  // Ao voltar para a aba, sincroniza e retoma a leitura da conversa aberta.
  private onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    void this.sync(false);
    if (this.viewing) this.queueRead(this.viewing);
  };

  // Atualiza o estado e avisa os ouvintes.
  private set(patch: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }

  // Altera o histórico de uma conversa, criando-o vazio se não existir.
  private updateThread(conversationId: string, update: (thread: Thread) => Thread) {
    this.set((state) => {
      const current: Thread = state.threads[conversationId] ?? {
        messages: [],
        phase: "ready",
        error: null,
        olderNext: null,
        loadingOlder: false,
        syncedId: 0,
      };
      return { threads: { ...state.threads, [conversationId]: update(current) } };
    });
  }

  // Troca a mensagem pendente que tem o id do cliente informado.
  private replacePending(conversationId: string, clientId: string, replacement: UiMessage) {
    this.updateThread(conversationId, (thread) => ({
      ...thread,
      messages: thread.messages.map((item) =>
        item.status && item.id_cliente === clientId ? replacement : item,
      ),
    }));
  }

  // Mescla conversas novas com as atuais sem retroceder marcadores de leitura nem a última mensagem.
  private mergeConversations(
    current: Record<string, Conversa>,
    incoming: Conversa[],
  ): Record<string, Conversa> {
    const next = { ...current };
    for (const fresh of incoming) {
      this.noteConfirmedRead(fresh.id, "usuario", fresh.ultima_lida_usuario);
      this.noteConfirmedRead(fresh.id, "henrique", fresh.ultima_lida_henrique);
      const old = next[fresh.id];
      next[fresh.id] = old
        ? {
            ...fresh,
            ultima_lida_usuario: Math.max(old.ultima_lida_usuario, fresh.ultima_lida_usuario),
            ultima_lida_henrique: Math.max(old.ultima_lida_henrique, fresh.ultima_lida_henrique),
            ultima_mensagem:
              old.ultima_mensagem && (!fresh.ultima_mensagem || old.ultima_mensagem.id > fresh.ultima_mensagem.id)
                ? old.ultima_mensagem
                : fresh.ultima_mensagem,
            atualizada_em: newerDate(old.atualizada_em, fresh.atualizada_em),
          }
        : fresh;
    }
    return next;
  }

  // Diz se a mensagem foi escrita pelo lado de quem usa o chat.
  private isMine(message: Mensagem): boolean {
    return this.state.profile?.operador ? message.origem !== "usuario" : message.origem === "usuario";
  }

  // Diz se a aba do navegador está visível.
  private isVisible(): boolean {
    return document.visibilityState === "visible";
  }

  // Incorpora uma mensagem recebida ao histórico e à conversa, contando não lidas quando cabe.
  private receive(message: Mensagem) {
    const mine = this.isMine(message);
    const watching = this.viewing === message.conversa_id && this.isVisible();

    this.set((state) => {
      const conversation = state.conversations[message.conversa_id];
      const thread = state.threads[message.conversa_id];
      const patch: Partial<ChatState> = {};

      if (thread) {
        patch.threads = {
          ...state.threads,
          [message.conversa_id]: { ...thread, messages: mergeMessages(thread.messages, [message]) },
        };
      }
      if (conversation) {
        const known = !!conversation.ultima_mensagem && conversation.ultima_mensagem.id >= message.id;
        patch.conversations = {
          ...state.conversations,
          [message.conversa_id]: {
            ...conversation,
            ultima_mensagem: known ? conversation.ultima_mensagem : message,
            atualizada_em: newerDate(conversation.atualizada_em, message.criada_em),
            nao_lidas: !mine && !known && !watching ? conversation.nao_lidas + 1 : conversation.nao_lidas,
          },
        };
      }
      return patch;
    });

    if (!this.state.conversations[message.conversa_id]) void this.refreshConversation(message.conversa_id);
    else if (!mine && this.viewing === message.conversa_id) this.queueRead(message.conversa_id);
  }

  // Busca a conversa no servidor e atualiza o estado.
  private async refreshConversation(conversationId: string) {
    const signal = this.abort?.signal;
    if (!signal) return;

    try {
      const conversation = await getConversa(this.token, conversationId, signal);
      this.set((state) => ({ conversations: this.mergeConversations(state.conversations, [conversation]) }));
    } catch (error) {
      this.handleFailure(error, signal);
    }
  }

  // Abre a conversa com o destinatário no servidor e registra falhas da caixa de entrada.
  private async createInbox(destinatario: Destinatario): Promise<string | null> {
    const signal = this.abort?.signal;
    if (!signal) return null;

    try {
      const conversation = await abrirConversa(this.token, destinatario, signal);
      this.set((state) => ({
        conversations: this.mergeConversations(state.conversations, [conversation]),
        inboxErrors: { ...state.inboxErrors, [destinatario]: undefined },
      }));
      return conversation.id;
    } catch (error) {
      if (this.handleFailure(error, signal)) return null;
      this.set((state) => ({ inboxErrors: { ...state.inboxErrors, [destinatario]: messageOf(error) } }));
      return null;
    }
  }

  // Entrega a mensagem; com o assistente de IA usa uma fila por conversa, pois o backend responde uma pergunta por vez.
  private enqueue(message: UiMessage) {
    if (!this.answersAutomatically(message.conversa_id)) {
      void this.deliver(message);
      return;
    }

    const next = (this.deliveries.get(message.conversa_id) ?? Promise.resolve()).then(() => this.deliver(message));
    this.deliveries.set(message.conversa_id, next);
    void next.finally(() => {
      if (this.deliveries.get(message.conversa_id) === next) this.deliveries.delete(message.conversa_id);
    });
  }

  // Diz se a conversa é com o assistente de IA ativo, que responde sozinho.
  private answersAutomatically(conversationId: string): boolean {
    const { profile, conversations } = this.state;
    return (
      !!profile?.assistente_ia_ativo &&
      !profile.operador &&
      conversations[conversationId]?.destinatario === "assistente"
    );
  }

  // Envia a mensagem à API, busca a resposta do assistente e marca falha se der erro.
  private async deliver(message: UiMessage) {
    const signal = this.abort?.signal;
    if (!signal) return;

    try {
      const sent = await enviarMensagem(
        this.token,
        message.conversa_id,
        message.conteudo,
        message.id_cliente,
        signal,
      );
      this.receive(sent);
      if (this.answersAutomatically(message.conversa_id)) {
        await this.catchUp(message.conversa_id, signal).catch((error) => this.handleFailure(error, signal));
      }
    } catch (error) {
      if (this.handleFailure(error, signal)) return;
      this.replacePending(message.conversa_id, message.id_cliente, {
        ...message,
        status: "falhou",
        erro: messageOf(error),
      });
    }
  }

  // Agenda o envio da marca de leitura, agrupando chamadas próximas.
  private queueRead(conversationId: string, delay = 350) {
    window.clearTimeout(this.readTimers.get(conversationId));
    this.readTimers.set(
      conversationId,
      window.setTimeout(() => {
        this.readTimers.delete(conversationId);
        void this.flushRead(conversationId);
      }, delay),
    );
  }

  // Marca a conversa como lida no servidor de forma otimista, com novas tentativas em caso de falha.
  private async flushRead(conversationId: string) {
    const signal = this.abort?.signal;
    const { conversations, threads, profile } = this.state;
    const conversation = conversations[conversationId];
    const thread = threads[conversationId];
    if (
      !signal ||
      !profile ||
      !conversation ||
      thread?.phase !== "ready" ||
      this.viewing !== conversationId ||
      !this.isVisible()
    ) {
      return;
    }

    const lastId = lastConfirmedId(thread.messages);
    const side = profile.operador ? "henrique" : "usuario";
    const marker = side === "usuario" ? conversation.ultima_lida_usuario : conversation.ultima_lida_henrique;
    if (lastId === 0 || (lastId <= marker && conversation.nao_lidas === 0)) return;

    const pending = this.pendingReads.get(conversationId);
    if (pending) pending.requests += 1;
    else this.pendingReads.set(conversationId, { requests: 1, unread: conversation.nao_lidas, failedTop: 0 });

    this.applyRead(conversationId, side, lastId, true);
    try {
      const result = await marcarLida(this.token, conversationId, lastId, signal);
      this.readAttempts.delete(conversationId);
      this.noteConfirmedRead(conversationId, result.por, result.mensagem_id);
      this.applyRead(conversationId, result.por, result.mensagem_id, false);
      this.settleRead(conversationId, side, lastId, true);
    } catch (error) {
      if (this.handleFailure(error, signal)) return;

      this.settleRead(conversationId, side, lastId, false);
      const attempts = (this.readAttempts.get(conversationId) ?? 0) + 1;
      this.readAttempts.set(conversationId, attempts);
      if (attempts < MAX_READ_ATTEMPTS) this.queueRead(conversationId, 4000 * attempts);
    }
  }

  // Registra o maior marcador de leitura confirmado pelo servidor.
  private noteConfirmedRead(conversationId: string, by: "usuario" | "henrique", messageId: number) {
    const key = `${conversationId}:${by}`;
    this.confirmedReads.set(key, Math.max(this.confirmedReads.get(key) ?? 0, messageId));
  }

  // Conclui uma leitura em voo e desfaz a atualização otimista se nenhuma foi confirmada.
  private settleRead(conversationId: string, by: "usuario" | "henrique", requestedId: number, succeeded: boolean) {
    const pending = this.pendingReads.get(conversationId);
    if (!pending) return;

    pending.requests -= 1;
    if (succeeded) pending.unread = 0;
    else pending.failedTop = Math.max(pending.failedTop, requestedId);
    if (pending.requests > 0) return;

    this.pendingReads.delete(conversationId);
    const confirmed = this.confirmedReads.get(`${conversationId}:${by}`) ?? 0;
    if (confirmed >= pending.failedTop) return;

    this.set((state) => {
      const conversation = state.conversations[conversationId];
      if (!conversation) return {};

      const field = by === "usuario" ? "ultima_lida_usuario" : "ultima_lida_henrique";
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...conversation,
            [field]: confirmed,
            nao_lidas: Math.max(conversation.nao_lidas, pending.unread),
          },
        },
      };
    });
  }

  // Aplica localmente o marcador de leitura e, se pedido, zera as não lidas.
  private applyRead(conversationId: string, by: "usuario" | "henrique", messageId: number, clearUnread: boolean) {
    this.set((state) => {
      const conversation = state.conversations[conversationId];
      if (!conversation) return {};
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            ...conversation,
            ultima_lida_usuario:
              by === "usuario" ? Math.max(conversation.ultima_lida_usuario, messageId) : conversation.ultima_lida_usuario,
            ultima_lida_henrique:
              by === "henrique" ? Math.max(conversation.ultima_lida_henrique, messageId) : conversation.ultima_lida_henrique,
            nao_lidas: clearUnread ? 0 : conversation.nao_lidas,
          },
        },
      };
    });
  }

  // Carrega perfil e primeira página de conversas e abre a conexão em tempo real.
  private async bootstrap() {
    const signal = this.abort?.signal;
    if (!signal) return;

    this.set({ phase: "loading", error: null });
    try {
      const profile = await getPerfil(this.token, signal);
      const page = await listConversas(this.token, { signal });
      this.set((state) => ({
        profile,
        phase: "ready",
        conversations: this.mergeConversations(state.conversations, page.results),
        listNext: { ...state.listNext, todas: page.next },
      }));
      this.connect();
    } catch (error) {
      if (this.handleFailure(error, signal)) return;
      this.set({ phase: "error", error: messageOf(error) });
    }
  }

  // Atualiza a lista e as mensagens novas (da conversa aberta ou de todas), uma sincronização por vez.
  private async sync(everyThread: boolean) {
    const signal = this.abort?.signal;
    if (!signal || !this.state.profile || !this.isVisible()) return;
    if (this.syncing) {
      if (everyThread) this.fullSyncQueued = true;
      return;
    }

    this.syncing = true;
    try {
      const page = await listConversas(this.token, {
        destinatario: this.filter === "todas" ? undefined : this.filter,
        signal,
      });
      this.set((state) => ({ conversations: this.mergeConversations(state.conversations, page.results) }));
      if (this.viewing && this.state.conversations[this.viewing]?.nao_lidas) this.queueRead(this.viewing);

      const ids = everyThread
        ? Object.keys(this.state.threads)
        : this.viewing && this.state.threads[this.viewing]
          ? [this.viewing]
          : [];
      for (const id of ids) await this.catchUp(id, signal);
    } catch (error) {
      this.handleFailure(error, signal);
    } finally {
      this.syncing = false;
      if (this.fullSyncQueued && this.started) {
        this.fullSyncQueued = false;
        void this.sync(true);
      }
    }
  }

  // Busca as mensagens novas desde o último id sincronizado; se forem demais, descarta o histórico.
  private async catchUp(conversationId: string, signal: AbortSignal) {
    const thread = this.state.threads[conversationId];
    if (thread?.phase !== "ready") return;

    const baseline = thread.syncedId;
    let highest = baseline;
    let cursor: string | null = null;

    for (let round = 0; round < MAX_CATCH_UP_PAGES; round += 1) {
      const page: Awaited<ReturnType<typeof getMensagens>> = await getMensagens(this.token, conversationId, {
        aposId: baseline,
        tamanho: 100,
        next: cursor,
        signal,
      });
      page.results.forEach((message) => {
        highest = Math.max(highest, message.id);
        this.receive(message);
      });

      cursor = page.next;
      if (!cursor) {
        this.updateThread(conversationId, (current) => ({ ...current, syncedId: Math.max(current.syncedId, highest) }));
        return;
      }
    }

    this.dropThread(conversationId);
  }

  // Descarta o histórico local preservando as mensagens não enviadas e recarrega se estiver aberto.
  private dropThread(conversationId: string) {
    this.set((state) => {
      const threads = { ...state.threads };
      const unsent = (threads[conversationId]?.messages ?? []).filter((message) => message.status);
      if (unsent.length === 0) {
        delete threads[conversationId];
      } else {
        threads[conversationId] = {
          messages: unsent,
          phase: "error",
          error: "A conversa precisa ser recarregada.",
          olderNext: null,
          loadingOlder: false,
          syncedId: 0,
        };
      }
      return { threads };
    });
    if (this.viewing === conversationId) void this.ensureThread(conversationId);
  }

  // Trata cancelamento e sessão expirada (401); devolve true quando o erro já foi tratado.
  private handleFailure(error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    if (error instanceof ApiError && error.status === 401) {
      this.expire();
      return true;
    }
    return false;
  }

  // Encerra a store e avisa que a sessão expirou.
  private expire() {
    this.stop();
    this.onSessionExpired();
  }

  // Abre o WebSocket com prazo para autenticar; em falha, usa consulta periódica e reconecta.
  private connect() {
    const profile = this.state.profile;
    if (!this.started || this.socket || !profile) return;

    this.syncPolling();
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl(profile.websocket_path));
    } catch {
      this.setLink("polling");
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;
    this.authTimer = window.setTimeout(() => socket.close(), 12000);

    // Lê o JSON recebido e repassa os eventos válidos.
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!data || typeof data !== "object" || !("type" in data)) return;
      this.handleSocketEvent(socket, data as { type: string } & Record<string, unknown>);
    };

    // Limpa temporizadores e reconecta, ou encerra a sessão se o servidor recusar a autenticação.
    socket.onclose = (event) => {
      window.clearTimeout(this.authTimer);
      window.clearInterval(this.pingTimer);
      window.clearInterval(this.reconcileTimer);
      if (this.socket === socket) this.socket = null;
      if (!this.started) return;

      if (event.code === 4401) {
        this.expire();
        return;
      }
      this.setLink("polling");
      if (event.code === 4403) void this.bootstrap();
      else this.scheduleReconnect();
    };
  }

  // Trata cada tipo de evento do servidor: autenticação, mensagens, leituras e conversas.
  private handleSocketEvent(socket: WebSocket, event: { type: string } & Record<string, unknown>) {
    switch (event.type) {
      case "autenticacao.necessaria":
        socket.send(JSON.stringify({ type: "autenticar", token: this.token }));
        break;
      case "autenticado":
        window.clearTimeout(this.authTimer);
        this.attempts = 0;
        this.setLink("live");
        window.clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, PING_MS);
        window.clearInterval(this.reconcileTimer);
        this.reconcileTimer = window.setInterval(() => void this.sync(false), RECONCILE_MS);
        void this.sync(true);
        break;
      case "mensagem.criada":
      case "mensagem.confirmada":
        if (isMensagem(event.mensagem)) this.receive(event.mensagem);
        break;
      case "conversa.lida":
        this.handleReadEvent(event);
        break;
      case "conversa.criada":
        if (typeof event.conversa_id === "string") void this.refreshConversation(event.conversa_id);
        break;
      case "erro":
        if (event.codigo === "authentication_failed") this.expire();
        break;
      default:
        break;
    }
  }

  // Aplica um evento de leitura vindo do servidor.
  private handleReadEvent(event: Record<string, unknown>) {
    const { conversa_id: conversationId, por: by, mensagem_id: messageId } = event;
    const profile = this.state.profile;
    if (
      typeof conversationId !== "string" ||
      (by !== "usuario" && by !== "henrique") ||
      typeof messageId !== "number" ||
      !profile
    ) {
      return;
    }

    const conversation = this.state.conversations[conversationId];
    const mySide = profile.operador ? "henrique" : "usuario";
    const myMarker = mySide === "usuario" ? conversation?.ultima_lida_usuario : conversation?.ultima_lida_henrique;
    this.noteConfirmedRead(conversationId, by, messageId);
    this.applyRead(conversationId, by, messageId, false);
    if (by === mySide && messageId > (myMarker ?? 0)) void this.refreshConversation(conversationId);
  }

  // Atualiza o estado da conexão e liga ou desliga a consulta periódica.
  private setLink(link: ChatState["link"]) {
    if (this.state.link !== link) this.set({ link });
    this.syncPolling();
  }

  // Mantém a consulta periódica ativa só quando o WebSocket não está ao vivo.
  private syncPolling() {
    const needsPolling = this.started && this.state.link !== "live";
    if (needsPolling && !this.pollTimer) {
      this.pollTimer = window.setInterval(() => void this.sync(false), POLL_MS);
    } else if (!needsPolling && this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = 0;
    }
  }

  // Agenda nova conexão com espera exponencial (até 30 s) e variação aleatória.
  private scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.attempts) + Math.random() * 400;
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  // Fecha o WebSocket e cancela seus temporizadores.
  private closeSocket() {
    window.clearTimeout(this.authTimer);
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.reconcileTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }
}
