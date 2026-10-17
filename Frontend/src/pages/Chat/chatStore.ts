import {
  ApiError,
  abrirConversa,
  encerrarSessao,
  enviarMensagem,
  getConversa,
  getMensagens,
  getPerfil,
  listConversas,
  marcarLida,
  novoUuid,
  socketUrl,
  type Conversa,
  type Destinatario,
  type Mensagem,
  type Perfil,
} from "./chatApi";

export type Filtro = "todas" | Destinatario;
export type UiMessage = Mensagem & { status?: "enviando" | "falhou"; erro?: string };

export type Thread = {
  messages: UiMessage[];
  phase: "loading" | "ready" | "error";
  error: string | null;
  olderNext: string | null;
  loadingOlder: boolean;
  syncedId: number;
};

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

export function lastConfirmedId(messages: UiMessage[]): number {
  return messages.reduce((highest, message) => (message.status ? highest : Math.max(highest, message.id)), 0);
}

export function inboxItems(conversations: Record<string, Conversa>, filter: Filtro): Conversa[] {
  return Object.values(conversations)
    .filter((item) => item.ultima_mensagem && (filter === "todas" || item.destinatario === filter))
    .sort((a, b) => Date.parse(b.atualizada_em) - Date.parse(a.atualizada_em));
}

export function totalUnread(state: ChatState): number {
  return Object.values(state.conversations).reduce((sum, conversation) => sum + conversation.nao_lidas, 0);
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Não foi possível concluir a solicitação.";
}

function isMensagem(value: unknown): value is Mensagem {
  return (
    !!value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "number" &&
    "conversa_id" in value &&
    typeof value.conversa_id === "string" &&
    "id_cliente" in value &&
    typeof value.id_cliente === "string"
  );
}

// Leituras otimistas em voo de uma conversa: `unread` guarda as não lidas de antes da primeira
// delas e `failedTop` o maior id cuja requisição falhou.
type PendingRead = { requests: number; unread: number; failedTop: number };

function newerDate(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

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
  private viewing: string | null = null;
  private filter: Filtro = "todas";
  private syncing = false;
  private started = false;
  private onSessionExpired: () => void = () => {};

  constructor(token: string) {
    this.token = token;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  setHandlers(handlers: { onSessionExpired: () => void }) {
    this.onSessionExpired = handlers.onSessionExpired;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.abort = new AbortController();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.set({ ...initialState });
    void this.bootstrap();
  }

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
    this.syncing = false;
    this.fullSyncQueued = false;
    this.attempts = 0;
    this.viewing = null;
  }

  reload() {
    if (this.started && this.state.phase !== "loading") void this.bootstrap();
  }

  clearInboxError(destinatario: Destinatario) {
    this.set((state) => ({ inboxErrors: { ...state.inboxErrors, [destinatario]: undefined } }));
  }

  async logout() {
    try {
      await encerrarSessao(this.token);
    } catch {
      // A sessão local termina mesmo que o servidor não confirme a revogação.
    }
    this.stop();
  }

  setViewing(conversationId: string | null) {
    if (this.viewing === conversationId) return;
    this.viewing = conversationId;
    if (!conversationId) return;
    void this.ensureThread(conversationId);
    this.queueRead(conversationId);
  }

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
        // "Carregar mais" avança o cursor, a menos que uma atualização o tenha reaberto no meio do caminho.
        // Uma atualização da primeira página só mexe nele quando termina em conversa desconhecida: há
        // páginas novas além dela, que o cursor atual (ou o fim da lista) deixaria inacessíveis.
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
    void this.deliver(pending);
  }

  retry(conversationId: string, clientId: string) {
    const message = this.state.threads[conversationId]?.messages.find(
      (item) => item.status === "falhou" && item.id_cliente === clientId,
    );
    if (!message) return;

    const retrying: UiMessage = { ...message, status: "enviando", erro: undefined };
    this.replacePending(conversationId, clientId, retrying);
    void this.deliver(retrying);
  }

  discard(conversationId: string, clientId: string) {
    this.updateThread(conversationId, (thread) => ({
      ...thread,
      messages: thread.messages.filter((item) => !(item.status && item.id_cliente === clientId)),
    }));
  }

  private onVisibility = () => {
    if (document.visibilityState !== "visible") return;
    void this.sync(false);
    if (this.viewing) this.queueRead(this.viewing);
  };

  private set(patch: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => listener());
  }

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

  private replacePending(conversationId: string, clientId: string, replacement: UiMessage) {
    this.updateThread(conversationId, (thread) => ({
      ...thread,
      messages: thread.messages.map((item) =>
        item.status && item.id_cliente === clientId ? replacement : item,
      ),
    }));
  }

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

  private isMine(message: Mensagem): boolean {
    return this.state.profile?.operador ? message.origem !== "usuario" : message.origem === "usuario";
  }

  private isVisible(): boolean {
    return document.visibilityState === "visible";
  }

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
    } catch (error) {
      if (this.handleFailure(error, signal)) return;
      this.replacePending(message.conversa_id, message.id_cliente, {
        ...message,
        status: "falhou",
        erro: messageOf(error),
      });
    }
  }

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

  private noteConfirmedRead(conversationId: string, by: "usuario" | "henrique", messageId: number) {
    const key = `${conversationId}:${by}`;
    this.confirmedReads.set(key, Math.max(this.confirmedReads.get(key) ?? 0, messageId));
  }

  private settleRead(conversationId: string, by: "usuario" | "henrique", requestedId: number, succeeded: boolean) {
    const pending = this.pendingReads.get(conversationId);
    if (!pending) return;

    pending.requests -= 1;
    if (succeeded) pending.unread = 0;
    else pending.failedTop = Math.max(pending.failedTop, requestedId);
    // O desfazer espera a última requisição em voo, para que cada falha não desfaça só uma parte.
    if (pending.requests > 0) return;

    this.pendingReads.delete(conversationId);
    const confirmed = this.confirmedReads.get(`${conversationId}:${by}`) ?? 0;
    // Uma leitura confirmada que cobre as falhas não deixa nada a desfazer.
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
            // Uma atualização da lista pode já ter trazido a contagem do servidor; somar contaria em dobro.
            nao_lidas: Math.max(conversation.nao_lidas, pending.unread),
          },
        },
      };
    });
  }

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

  private dropThread(conversationId: string) {
    this.set((state) => {
      const threads = { ...state.threads };
      // Mensagens ainda não confirmadas (enviando/falhou) só existem localmente e precisam sobreviver à recarga.
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

  private handleFailure(error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    if (error instanceof ApiError && error.status === 401) {
      this.expire();
      return true;
    }
    return false;
  }

  private expire() {
    this.stop();
    this.onSessionExpired();
  }

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

  private setLink(link: ChatState["link"]) {
    if (this.state.link !== link) this.set({ link });
    this.syncPolling();
  }

  private syncPolling() {
    const needsPolling = this.started && this.state.link !== "live";
    if (needsPolling && !this.pollTimer) {
      this.pollTimer = window.setInterval(() => void this.sync(false), POLL_MS);
    } else if (!needsPolling && this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = 0;
    }
  }

  private scheduleReconnect() {
    window.clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** this.attempts) + Math.random() * 400;
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

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
