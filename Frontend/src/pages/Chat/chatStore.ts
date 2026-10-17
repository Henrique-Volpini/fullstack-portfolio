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
};

export type ChatState = {
  phase: "loading" | "ready" | "error";
  error: string | null;
  profile: Perfil | null;
  link: "connecting" | "live" | "polling";
  conversations: Record<string, Conversa>;
  threads: Record<string, Thread>;
  listNext: Partial<Record<Filtro, string | null>>;
  listLoading: boolean;
  listError: string | null;
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
  listLoading: false,
  listError: null,
  inboxErrors: {},
};

const PAGE_SIZE = 30;
const POLL_MS = 5000;
const PING_MS = 30000;

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
  private readTimers = new Map<string, number>();
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
    this.readTimers.forEach((timer) => window.clearTimeout(timer));
    this.readTimers.clear();
    this.opening.clear();
    this.syncing = false;
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
    if (!signal || this.state.listLoading || (more && !cursor)) return;

    if (!more) this.filter = filter;
    this.set({ listLoading: true, listError: null });
    try {
      const page = await listConversas(this.token, {
        destinatario: filter === "todas" ? undefined : filter,
        next: cursor,
        signal,
      });
      this.set((state) => ({
        conversations: this.mergeConversations(state.conversations, page.results),
        listNext: { ...state.listNext, [filter]: page.next },
        listLoading: false,
      }));
    } catch (error) {
      if (this.handleFailure(error, signal)) return;
      this.set({ listLoading: false, listError: messageOf(error) });
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
      this.updateThread(conversationId, (thread) => ({
        ...thread,
        messages: mergeMessages(thread.messages, page.results),
        phase: "ready",
        error: null,
        olderNext: page.next,
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

  private queueRead(conversationId: string) {
    window.clearTimeout(this.readTimers.get(conversationId));
    this.readTimers.set(
      conversationId,
      window.setTimeout(() => {
        this.readTimers.delete(conversationId);
        void this.flushRead(conversationId);
      }, 350),
    );
  }

  private async flushRead(conversationId: string) {
    const signal = this.abort?.signal;
    const { conversations, threads, profile } = this.state;
    const conversation = conversations[conversationId];
    if (!signal || !profile || !conversation || this.viewing !== conversationId || !this.isVisible()) return;

    const lastId = Math.max(
      conversation.ultima_mensagem?.id ?? 0,
      lastConfirmedId(threads[conversationId]?.messages ?? []),
    );
    const side = profile.operador ? "henrique" : "usuario";
    const marker = side === "usuario" ? conversation.ultima_lida_usuario : conversation.ultima_lida_henrique;
    if (lastId === 0 || (lastId <= marker && conversation.nao_lidas === 0)) return;

    this.applyRead(conversationId, side, lastId, true);
    try {
      const result = await marcarLida(this.token, conversationId, lastId, signal);
      this.applyRead(conversationId, result.por, result.mensagem_id, false);
    } catch (error) {
      this.handleFailure(error, signal);
    }
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
    if (!signal || this.syncing || !this.state.profile || !this.isVisible()) return;

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
      for (const id of ids) {
        const thread = this.state.threads[id];
        if (thread?.phase !== "ready") continue;

        let cursor: string | null = null;
        for (let round = 0; round < 5; round += 1) {
          const fresh: Awaited<ReturnType<typeof getMensagens>> = await getMensagens(this.token, id, {
            aposId: lastConfirmedId(this.state.threads[id]?.messages ?? []),
            tamanho: 100,
            next: cursor,
            signal,
          });
          fresh.results.forEach((message) => this.receive(message));
          cursor = fresh.next;
          if (!cursor) break;
        }
      }
    } catch (error) {
      this.handleFailure(error, signal);
    } finally {
      this.syncing = false;
    }
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
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
    }
  }
}
