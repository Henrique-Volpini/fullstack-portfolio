import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { encerrarSessao, type Conversa, type Destinatario, type Perfil } from "./chatApi";
import { ChatStore, inboxItems, totalUnread, type Filtro, type Thread, type UiMessage } from "./chatStore";
import { texts } from "../../texts";
import "./Chat.css";

// Propriedades do chat: token, modo (mini ou tela cheia) e callbacks do painel.
type ChatProps = {
  token: string;
  mode: "mini" | "full";
  minimized: boolean;
  onClose: () => void;
  onExpand: () => void;
  onToggleMinimized: () => void;
  onLogout: (revoked: boolean) => void;
  onSessionExpired: () => void;
};

// Linha da conversa: separador de dia ou mensagem com dados de agrupamento.
type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: UiMessage; mine: boolean; first: boolean; seen: boolean; index: number };

const MAX_LENGTH = 4000;
const timeFormat = new Intl.DateTimeFormat(texts.locale, { hour: "2-digit", minute: "2-digit" });
const shortDayFormat = new Intl.DateTimeFormat(texts.locale, { day: "2-digit", month: "short" });

// Hook que cria a ChatStore, inscreve o componente nas mudanças e controla o início e o fim da conexão.
function useChatStore(token: string, onSessionExpired: () => void) {
  const [store] = useState(() => new ChatStore(token));
  const state = useSyncExternalStore(store.subscribe, store.getState);

  useEffect(() => {
    store.setHandlers({ onSessionExpired });
  }, [store, onSessionExpired]);

  useEffect(() => {
    const timer = window.setTimeout(() => store.start(), 0);
    return () => {
      window.clearTimeout(timer);
      store.stop();
    };
  }, [store]);

  return { store, state };
}

// Chave do dia de uma data, para agrupar mensagens.
function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// Rótulo do dia: Hoje, Ontem ou dia e mês.
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(iso) === dayKey(now.toISOString())) return texts.chat.today;
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return texts.chat.yesterday;
  return shortDayFormat.format(date).replace(".", "");
}

// Hora (se for hoje) ou data curta, para a lista de conversas.
function listTime(iso: string): string {
  return dayKey(iso) === dayKey(new Date().toISOString())
    ? timeFormat.format(new Date(iso))
    : shortDayFormat.format(new Date(iso)).replace(".", "");
}

// Diz se a mensagem é de quem usa o chat (operador ou visitante).
function isOwn(message: UiMessage, operator: boolean): boolean {
  return operator ? message.origem !== "usuario" : message.origem === "usuario";
}

// Monta as linhas da conversa: separadores de dia, agrupamento por remetente e marca de visto.
function buildRows(messages: UiMessage[], operator: boolean, otherMarker: number): Row[] {
  const rows: Row[] = [];
  let lastOwn = -1;
  messages.forEach((message, index) => {
    if (!message.status && isOwn(message, operator)) lastOwn = index;
  });

  let previous: UiMessage | null = null;
  messages.forEach((message, index) => {
    const newDay = !previous || dayKey(previous.criada_em) !== dayKey(message.criada_em);
    if (newDay) rows.push({ kind: "day", key: `day:${dayKey(message.criada_em)}`, label: dayLabel(message.criada_em) });

    const first =
      newDay ||
      !previous ||
      previous.origem !== message.origem ||
      previous.remetente.nome !== message.remetente.nome ||
      Date.parse(message.criada_em) - Date.parse(previous.criada_em) > 5 * 60_000;

    rows.push({
      kind: "message",
      key: `${message.origem}:${message.id_cliente}`,
      message,
      mine: isOwn(message, operator),
      first,
      seen: index === lastOwn && message.id > 0 && message.id <= otherMarker,
      index,
    });
    previous = message;
  });
  return rows;
}

// Rola o elemento até a posição com animação suave.
function smoothScroll(element: HTMLElement, target: number, duration = 320) {
  const start = element.scrollTop;
  const distance = target - start;
  const startedAt = performance.now();
  // Avança um quadro da animação de rolagem.
  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    element.scrollTop = start + distance * (1 - (1 - progress) ** 3);
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Ícone de seta para baixo (minimizar).
function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Ícone de expandir para tela cheia.
function IconExpand() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
    </svg>
  );
}

// Ícone de fechar.
function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

// Ícone de seta para voltar.
function IconBack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

// Ícone de seta para enviar.
function IconSend() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}

// Indicador do estado da conexão: ao vivo, conectando ou atualizando por consulta.
function LinkStatus({ link }: { link: "connecting" | "live" | "polling" }) {
  const label = texts.chat.link[link];
  return <span className="chat-link" data-link={link} role="img" aria-label={label} title={label} />;
}

// Abas genéricas com indicador animado e contagem opcional de não lidas.
function Tabs<T extends string>({
  items,
  value,
  label,
  onChange,
}: {
  items: Array<{ id: T; label: string; badge?: number }>;
  value: T;
  label: string;
  onChange: (id: T) => void;
}) {
  const index = Math.max(0, items.findIndex((item) => item.id === value));
  return (
    <div
      className="chat-tabs"
      role="group"
      aria-label={label}
      style={{ "--tab-index": index, "--tab-count": items.length } as CSSProperties}
    >
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          aria-pressed={item.id === value}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.badge ? (
            <span className="chat-dot" aria-label={texts.chat.unread(item.badge)}>
              {item.badge > 9 ? "9+" : item.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// Placeholder animado exibido enquanto o conteúdo carrega.
function Skeleton() {
  return (
    <div className="chat-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

// Campo de escrita da mensagem, com altura automática e envio por Enter.
function Composer({
  value,
  disabled,
  placeholder,
  onChange,
  onSend,
}: {
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [value]);

  // Envia a mensagem se houver texto e o campo estiver habilitado.
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!disabled && value.trim()) onSend();
  };

  // Enter envia e Shift+Enter quebra a linha; em telas de toque, Enter só quebra a linha.
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const touchKeyboard = window.matchMedia("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchKeyboard) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="chat-composer" onSubmit={submit}>
      {/* Campo de texto com contador perto do limite de caracteres. */}
      <div className="chat-composer-field">
        <textarea
          ref={field}
          rows={1}
          value={value}
          maxLength={MAX_LENGTH}
          placeholder={placeholder}
          aria-label={texts.chat.messageLabel}
          disabled={disabled}
          data-autofocus=""
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {value.length > MAX_LENGTH - 500 && (
          <span className="chat-count">
            {value.length}/{MAX_LENGTH}
          </span>
        )}
      </div>
      <button
        className="chat-send"
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label={texts.chat.send}
        onMouseDown={(event) => event.preventDefault()}
      >
        <IconSend />
      </button>
    </form>
  );
}

// Uma mensagem da conversa, com estados de envio, falha (tentar de novo ou descartar) e visto.
function MessageRow({
  row,
  awaitingAssistant,
  onRetry,
  onDiscard,
}: {
  row: Extract<Row, { kind: "message" }>;
  awaitingAssistant: boolean;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const { message, mine, first, seen, index } = row;

  return (
    <div
      className="chat-msg"
      data-mine={mine}
      data-first={first}
      data-status={message.status}
      style={{ "--i": Math.min(index, 14) } as CSSProperties}
    >
      {/* Nome do remetente e hora, na primeira mensagem de um grupo. */}
      {first && (
        <div className="chat-meta">
          {(!mine || message.origem === "assistente") && <span>{message.remetente.nome}</span>}
          <time dateTime={message.criada_em}>{timeFormat.format(new Date(message.criada_em))}</time>
        </div>
      )}
      {/* Balão com o texto da mensagem. */}
      <div className="chat-bubble">
        <p>{message.conteudo}</p>
      </div>
      {/* Aviso de envio em andamento. */}
      {message.status === "enviando" && (
        <span className="chat-state" role="status">
          {awaitingAssistant ? texts.chat.assistantReplying : texts.chat.sending}
        </span>
      )}
      {/* Falha no envio, com opção de tentar de novo ou descartar. */}
      {message.status === "falhou" && (
        <span className="chat-state chat-state-error" role="alert">
          <span>{message.erro ?? texts.chat.notSent}</span>
          <button type="button" onClick={() => onRetry(message.id_cliente)}>
            {texts.chat.retryMessage}
          </button>
          <button type="button" onClick={() => onDiscard(message.id_cliente)}>
            {texts.chat.discard}
          </button>
        </span>
      )}
      {seen && !message.status && <span className="chat-state">{texts.chat.seen}</span>}
    </div>
  );
}

// Conversa aberta: cabeçalho, histórico rolável, botão de recentes e campo de escrita.
function ThreadView({
  store,
  profile,
  conversation,
  conversationId,
  thread,
  inboxError,
  recipientName,
  draft,
  onDraft,
  onRetryInbox,
  onBack,
}: {
  store: ChatStore;
  profile: Perfil;
  conversation: Conversa | undefined;
  conversationId: string | null;
  thread: Thread | undefined;
  inboxError: string | undefined;
  recipientName: string;
  draft: string;
  onDraft: (value: string) => void;
  onRetryInbox: () => void;
  onBack: (() => void) | null;
}) {
  const operator = profile.operador;
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const anchor = useRef<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [intro, setIntro] = useState(true);

  const otherMarker = operator ? conversation?.ultima_lida_usuario ?? 0 : conversation?.ultima_lida_henrique ?? 0;
  const messages = thread?.messages;
  const rows = useMemo(
    () => buildRows(messages ?? [], operator, otherMarker),
    [messages, operator, otherMarker],
  );
  const lastRow = rows[rows.length - 1];
  const lastKey = lastRow?.key;
  const firstId = messages?.[0]?.id;
  const lastIsOwn = lastRow?.kind === "message" && lastRow.mine;
  const lastStatus = lastRow?.kind === "message" ? lastRow.message.status : undefined;
  const ready = thread?.phase === "ready" && !!conversationId;
  const withAssistant = !operator && conversation?.destinatario === "assistente";
  const assistantNote = withAssistant && !profile.assistente_ia_ativo;
  const awaitingAssistant = withAssistant && profile.assistente_ia_ativo;

  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), 1000);
    return () => window.clearTimeout(timer);
  }, []);

  useLayoutEffect(() => {
    const element = log.current;
    if (element && (stick.current || lastIsOwn)) element.scrollTop = element.scrollHeight;
  }, [lastKey, lastIsOwn, lastStatus, thread?.phase]);

  useLayoutEffect(() => {
    const element = log.current;
    if (element && anchor.current !== null) {
      element.scrollTop += element.scrollHeight - anchor.current;
      anchor.current = null;
    }
  }, [firstId]);

  // Registra se o histórico está perto do fim, para manter a rolagem colada nas novas mensagens.
  const handleScroll = () => {
    const element = log.current;
    if (!element) return;
    // Enquanto o painel anima, a altura do histórico é provisória: mede de novo quando a animação terminar.
    const panel = element.closest<HTMLElement>(".auth-panel");
    const resizing = panel?.getAnimations()[0];
    if (resizing) {
      void resizing.finished.catch(() => undefined).then(handleScroll);
      return;
    }
    // Minimizado, o histórico quase não tem altura e a distância até o fim não significa nada.
    if (panel?.dataset.minimized === "true") return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    stick.current = nearBottom;
    setAtBottom(nearBottom);
  };

  // Carrega as mensagens anteriores e guarda a posição de rolagem para a tela não pular.
  const loadOlder = () => {
    if (!conversationId) return;
    anchor.current = log.current?.scrollHeight ?? null;
    void store.loadOlder(conversationId);
  };

  // Rola suavemente até a mensagem mais recente.
  const jumpToEnd = () => {
    const element = log.current;
    if (element) smoothScroll(element, element.scrollHeight - element.clientHeight);
  };

  // Envia o rascunho pela store e limpa o campo.
  const send = () => {
    if (!conversationId) return;
    stick.current = true;
    store.send(conversationId, draft);
    onDraft("");
  };

  return (
    <section className="chat-thread" aria-label={texts.chat.threadLabel(recipientName)}>
      {/* Cabeçalho com botão voltar, nome do visitante e destinatário (visão do operador). */}
      {onBack && (
        <div className="chat-thread-head">
          <button className="chat-back" type="button" onClick={onBack} aria-label={texts.chat.backLabel}>
            <IconBack />
            <span>{texts.chat.inbox}</span>
          </button>
          <span className="chat-thread-name">{conversation?.usuario.username ?? recipientName}</span>
          {conversation && <span className="chat-tag">{conversation.nome_destinatario}</span>}
        </div>
      )}

      {/* Histórico rolável de mensagens, anunciado a leitores de tela. */}
      <div
        className="chat-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        data-intro={intro}
        onScroll={handleScroll}
      >
        {/* Aviso de que o assistente ainda não responde sozinho. */}
        {assistantNote && (
          <p className="chat-note">{texts.chat.assistantNote}</p>
        )}

        {/* Erro ao abrir a caixa de entrada, com botão para tentar de novo. */}
        {inboxError && (
          <div className="chat-state-box" role="alert">
            <p>{inboxError}</p>
            <button type="button" onClick={onRetryInbox}>
              {texts.chat.retry}
            </button>
          </div>
        )}

        {/* Carregamento da conversa. */}
        {!inboxError && !ready && thread?.phase !== "error" && <Skeleton />}

        {/* Erro ao carregar as mensagens, com botão para tentar de novo. */}
        {thread?.phase === "error" && conversationId && (
          <div className="chat-state-box" role="alert">
            <p>{thread.error}</p>
            <button type="button" onClick={() => void store.ensureThread(conversationId)}>
              {texts.chat.retry}
            </button>
          </div>
        )}

        {/* Botão para carregar as mensagens anteriores. */}
        {ready && thread.olderNext && (
          <button className="chat-older" type="button" onClick={loadOlder} disabled={thread.loadingOlder}>
            {thread.loadingOlder ? texts.chat.loading : texts.chat.olderMessages}
          </button>
        )}

        {/* Conversa ainda sem mensagens. */}
        {ready && rows.length === 0 && (
          <div className="chat-empty">
            <p>{texts.chat.empty}</p>
            <p className="chat-empty-hint">
              {operator ? texts.chat.emptyOperatorHint : texts.chat.emptyVisitorHint(recipientName)}
            </p>
          </div>
        )}

        {/* Separadores de dia e mensagens, em ordem cronológica. */}
        {rows.map((row) =>
          row.kind === "day" ? (
            <div className="chat-day" key={row.key}>
              <span>{row.label}</span>
            </div>
          ) : (
            <MessageRow
              key={row.key}
              row={row}
              awaitingAssistant={awaitingAssistant}
              onRetry={(clientId) => conversationId && store.retry(conversationId, clientId)}
              onDiscard={(clientId) => conversationId && store.discard(conversationId, clientId)}
            />
          ),
        )}
      </div>

      {/* Botão para voltar às mensagens mais recentes. */}
      {!atBottom && rows.length > 0 && (
        <button className="chat-jump" type="button" onClick={jumpToEnd}>
          {texts.chat.jumpToLatest} <span aria-hidden="true">↓</span>
        </button>
      )}

      {operator && <p className="chat-hint">{texts.chat.operatorHint}</p>}
      <Composer
        value={draft}
        disabled={!ready}
        placeholder={operator ? texts.chat.replyPlaceholder : texts.chat.messagePlaceholder(recipientName)}
        onChange={onDraft}
        onSend={send}
      />
    </section>
  );
}

// Lista de conversas do operador, com estados de erro, vazio e carregamento.
function ConversationList({
  conversations,
  filter,
  loading,
  error,
  hasMore,
  onMore,
  onRetry,
  onSelect,
}: {
  conversations: Record<string, Conversa>;
  filter: Filtro;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onMore: () => void;
  onRetry: () => void;
  onSelect: (id: string) => void;
}) {
  const items = useMemo(() => inboxItems(conversations, filter), [conversations, filter]);

  if (error && items.length === 0) {
    return (
      // Falha ao carregar a lista, com botão para tentar de novo.
      <div className="chat-state-box" role="alert">
        <p>{error}</p>
        <button type="button" onClick={onRetry}>
          {texts.chat.retry}
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return loading || hasMore ? (
      <Skeleton />
    ) : (
      // Lista vazia, com dica de onde as mensagens aparecem.
      <div className="chat-empty">
        <p>{texts.chat.noConversations}</p>
        <p className="chat-empty-hint">{texts.chat.noConversationsHint}</p>
      </div>
    );
  }

  return (
    // Conversas da mais recente para a mais antiga.
    <ul className="chat-list">
      {/* Uma linha por conversa, com nome, hora, prévia, destinatário e não lidas. */}
      {items.map((item, index) => {
        const last = item.ultima_mensagem;
        const fromMe = !!last && last.origem !== "usuario";
        return (
          <li key={item.id} style={{ "--i": Math.min(index, 8) } as CSSProperties}>
            <button type="button" onClick={() => onSelect(item.id)} data-unread={item.nao_lidas > 0}>
              <span className="chat-list-main">
                <span className="chat-list-name">{item.usuario.username}</span>
                <time dateTime={item.atualizada_em}>{listTime(item.atualizada_em)}</time>
              </span>
              <span className="chat-list-preview">
                {fromMe ? (last?.origem === "assistente" ? texts.chat.previewFromAssistant : texts.chat.previewFromMe) : ""}
                {last?.conteudo}
              </span>
              <span className="chat-list-tags">
                <span className="chat-tag">{item.nome_destinatario}</span>
                {item.nao_lidas > 0 && (
                  <span className="chat-dot" aria-label={texts.chat.unread(item.nao_lidas)}>
                    {item.nao_lidas > 9 ? "9+" : item.nao_lidas}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
      {/* Botão para carregar mais conversas. */}
      {hasMore && (
        <li>
          <button className="chat-older" type="button" onClick={onMore} disabled={loading}>
            {loading ? texts.chat.loading : texts.chat.moreConversations}
          </button>
        </li>
      )}
    </ul>
  );
}

// Botões da barra superior: minimizar e expandir no modo mini; sair e fechar em tela cheia.
function ChatActions({
  mode,
  minimized,
  loggingOut,
  onToggleMinimized,
  onExpand,
  onLogout,
  onClose,
}: {
  mode: "mini" | "full";
  minimized: boolean;
  loggingOut: boolean;
  onToggleMinimized: () => void;
  onExpand: () => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  return mode === "mini" ? (
    <>
      <button
        className="chat-icon chat-toggle"
        type="button"
        onClick={onToggleMinimized}
        aria-label={minimized ? texts.chat.restore : texts.chat.minimize}
        aria-expanded={!minimized}
        data-minimized={minimized}
      >
        <IconChevron />
      </button>
      <button className="chat-icon" type="button" onClick={onExpand} aria-label={texts.chat.expand}>
        <IconExpand />
      </button>
    </>
  ) : (
    <>
      <button className="chat-text-button" type="button" onClick={onLogout} disabled={loggingOut}>
        {loggingOut ? texts.chat.loggingOut : texts.chat.logout}
      </button>
      <button
        className="chat-icon chat-close"
        type="button"
        onClick={onClose}
        aria-label={texts.chat.close}
      >
        <IconClose />
      </button>
    </>
  );
}

// Componente do chat: conexão e abas de destinatário para o visitante, caixa de entrada para o operador.
function ChatView({
  token,
  mode,
  minimized,
  onClose,
  onExpand,
  onToggleMinimized,
  onLogout,
  onSessionExpired,
}: ChatProps) {
  const { store, state } = useChatStore(token, onSessionExpired);
  const profile = state.profile;
  const ready = state.phase === "ready" && profile !== null;
  const operator = profile?.operador ?? false;
  const visible = mode === "full" || !minimized;

  const [inbox, setInbox] = useState<Destinatario>("henrique");
  const [filter, setFilter] = useState<Filtro>("todas");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loggingOut, setLoggingOut] = useState(false);

  const conversations = state.conversations;
  const inboxConversation = useMemo(
    () => (operator ? undefined : Object.values(conversations).find((item) => item.destinatario === inbox)),
    [conversations, inbox, operator],
  );
  const currentId = operator ? selectedId : (inboxConversation?.id ?? null);
  const currentConversation = currentId ? conversations[currentId] : undefined;
  const inboxError = operator ? undefined : state.inboxErrors[inbox];
  const unread = totalUnread(state);

  // Nome exibido do destinatário.
  const nameOf = (id: Destinatario) =>
    profile?.destinatarios.find((item) => item.id === id)?.nome ?? texts.chat.recipients[id];
  // Nome do destinatário com artigo, para usar em frases.
  const phraseOf = (id: Destinatario) => texts.chat.recipientInSentence(id, nameOf(id));
  // Não lidas na conversa com o destinatário.
  const unreadOf = (id: Destinatario) =>
    Object.values(conversations).find((item) => item.destinatario === id)?.nao_lidas ?? 0;

  useEffect(() => {
    if (ready && !operator && visible && !inboxConversation && !inboxError) void store.openInbox(inbox);
  }, [store, ready, operator, visible, inboxConversation, inboxError, inbox]);

  useEffect(() => {
    store.setViewing(visible ? currentId : null);
  }, [store, visible, currentId]);

  useEffect(() => {
    if (ready && operator && visible) void store.loadList(filter);
  }, [store, ready, operator, visible, filter]);

  const listLoading = !!state.listLoading[filter];
  const listError = state.listError[filter] ?? null;
  const hasMoreConversations = !!state.listNext[filter];
  const emptyInbox = useMemo(
    () => operator && inboxItems(conversations, filter).length === 0,
    [operator, conversations, filter],
  );

  useEffect(() => {
    if (ready && visible && !selectedId && emptyInbox && hasMoreConversations && !listLoading && !listError) {
      void store.loadList(filter, true);
    }
  }, [store, ready, visible, selectedId, emptyInbox, hasMoreConversations, listLoading, listError, filter]);

  // Encerra a sessão no servidor e avisa o painel.
  const handleLogout = async () => {
    setLoggingOut(true);
    const revoked = await store.logout();
    onLogout(revoked);
  };

  // Limpa o erro da caixa de entrada para tentar abri-la de novo.
  const retryInbox = () => store.clearInboxError(inbox);

  const headline = operator
    ? selectedId
      ? (currentConversation?.usuario.username ?? texts.chat.conversation)
      : texts.chat.inboxTitle
    : texts.chat.visitorTitle(phraseOf(inbox));
  const peek = operator
    ? selectedId
      ? (currentConversation?.usuario.username ?? texts.chat.conversation)
      : texts.chat.inbox
    : nameOf(inbox);

  const draftKey = currentId ?? `inbox:${inbox}`;

  return (
    // Raiz do chat: barra superior e corpo.
    <div
      className="chat"
      data-mode={mode}
      data-minimized={minimized}
    >
      {/* Barra superior: conexão, título e ações. */}
      <header className="chat-top">
        {/* Indicador de conexão e rótulo (ou nome do destinatário quando minimizado). */}
        <div className="chat-id">
          <LinkStatus link={state.link} />
          {minimized ? (
            <span className="chat-peek">{peek}</span>
          ) : (
            <span className="chat-label">{operator ? texts.chat.operatorLabel : texts.chat.label}</span>
          )}
        </div>

        {/* Ações: contador de não lidas, minimizar ou expandir, sair ou fechar. */}
        <div className="chat-actions">
          {mode === "mini" && minimized && unread > 0 && (
            <span className="chat-dot" aria-label={texts.chat.unread(unread)}>
              {unread > 9 ? "9+" : unread}
            </span>
          )}
          <ChatActions
            mode={mode}
            minimized={minimized}
            loggingOut={loggingOut}
            onToggleMinimized={onToggleMinimized}
            onExpand={onExpand}
            onLogout={handleLogout}
            onClose={onClose}
          />
        </div>
      </header>

      {/* Corpo do chat: título, carregamento, erros e conversa ou lista. */}
      <div className="chat-body" aria-hidden={minimized} inert={minimized}>
        {mode === "full" && (
          <h2 className="chat-title" key={headline}>
            {headline}
          </h2>
        )}

        {state.phase === "loading" && <Skeleton />}

        {/* Erro ao carregar o chat, com botão para tentar de novo. */}
        {state.phase === "error" && (
          <div className="chat-state-box" role="alert">
            <p>{state.error}</p>
            <button type="button" onClick={() => store.reload()}>
              {texts.chat.retry}
            </button>
          </div>
        )}

        {/* Visão do visitante: abas de destinatário e a conversa. */}
        {ready && !operator && (
          <>
            <Tabs
              label={texts.chat.recipientTabsLabel}
              value={inbox}
              onChange={setInbox}
              items={[
                { id: "henrique", label: nameOf("henrique"), badge: unreadOf("henrique") },
                { id: "assistente", label: nameOf("assistente"), badge: unreadOf("assistente") },
              ]}
            />
            <ThreadView
              key={inbox}
              store={store}
              profile={profile}
              conversation={currentConversation}
              conversationId={currentId}
              thread={currentId ? state.threads[currentId] : undefined}
              inboxError={inboxError}
              recipientName={phraseOf(inbox)}
              draft={drafts[draftKey] ?? ""}
              onDraft={(value) => setDrafts((current) => ({ ...current, [draftKey]: value }))}
              onRetryInbox={retryInbox}
              onBack={null}
            />
          </>
        )}

        {/* Visão do operador: filtros e lista de conversas. */}
        {ready && operator && !selectedId && (
          <>
            <Tabs
              label={texts.chat.filterLabel}
              value={filter}
              onChange={setFilter}
              items={[
                { id: "todas", label: texts.chat.filterAll },
                { id: "henrique", label: nameOf("henrique") },
                { id: "assistente", label: nameOf("assistente") },
              ]}
            />
            <ConversationList
              conversations={conversations}
              filter={filter}
              loading={listLoading}
              error={listError}
              hasMore={hasMoreConversations}
              onMore={() => void store.loadList(filter, true)}
              onRetry={() => void store.loadList(filter)}
              onSelect={setSelectedId}
            />
          </>
        )}

        {/* Visão do operador: conversa selecionada. */}
        {ready && operator && selectedId && (
          <ThreadView
            key={selectedId}
            store={store}
            profile={profile}
            conversation={currentConversation}
            conversationId={selectedId}
            thread={state.threads[selectedId]}
            inboxError={undefined}
            recipientName={currentConversation?.usuario.username ?? texts.chat.visitor}
            draft={drafts[draftKey] ?? ""}
            onDraft={(value) => setDrafts((current) => ({ ...current, [draftKey]: value }))}
            onRetryInbox={retryInbox}
            onBack={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

// Aviso exibido no lugar do chat quando ele quebra: mantém os controles do painel e permite tentar de novo ou sair.
function ChatFailure({
  token,
  mode,
  minimized,
  onClose,
  onExpand,
  onToggleMinimized,
  onLogout,
  onRetry,
}: ChatProps & { onRetry: () => void }) {
  const [loggingOut, setLoggingOut] = useState(false);
  const retryButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === "full") retryButton.current?.focus();
  }, [mode]);

  // Revoga a sessão no servidor e avisa o painel, como o botão Sair do chat.
  const handleLogout = async () => {
    setLoggingOut(true);
    onLogout(await encerrarSessao(token));
  };

  return (
    // Mesma estrutura do chat, para ocupar o painel nos modos mini, minimizado e tela cheia.
    <div className="chat" data-mode={mode} data-minimized={minimized}>
      <header className="chat-top">
        <div className="chat-id">
          {minimized ? (
            <span className="chat-peek">{texts.chat.conversation}</span>
          ) : (
            <span className="chat-label">{texts.chat.label}</span>
          )}
        </div>
        <div className="chat-actions">
          <ChatActions
            mode={mode}
            minimized={minimized}
            loggingOut={loggingOut}
            onToggleMinimized={onToggleMinimized}
            onExpand={onExpand}
            onLogout={handleLogout}
            onClose={onClose}
          />
        </div>
      </header>

      {/* Corpo com o aviso de erro e o botão para montar o chat de novo. */}
      <div className="chat-body" aria-hidden={minimized} inert={minimized}>
        {mode === "full" && <h2 className="chat-title">{texts.chat.unavailableTitle}</h2>}
        <div className="chat-state-box" role="alert">
          <p>{texts.chat.crashed}</p>
          <button type="button" ref={retryButton} onClick={onRetry}>
            {texts.chat.retry}
          </button>
        </div>
      </div>
    </div>
  );
}

// Limite de erro: se algo no chat lançar uma exceção ao renderizar, mostra o aviso sem derrubar o site.
class ChatErrorBoundary extends Component<
  { children: ReactNode; fallback: (retry: () => void) => ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  // Troca o chat pelo aviso quando um componente dele falha.
  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Monta o chat do zero, com uma nova conexão e um novo estado.
  retry = () => this.setState({ failed: false });

  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

// Chat protegido: uma falha inesperada fica restrita ao painel e o resto do site continua no ar.
function Chat(props: ChatProps) {
  return (
    <ChatErrorBoundary fallback={(retry) => <ChatFailure {...props} onRetry={retry} />}>
      <ChatView {...props} />
    </ChatErrorBoundary>
  );
}

export default Chat;
