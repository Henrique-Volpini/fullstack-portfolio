import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import type { Conversa, Destinatario, Perfil } from "./chatApi";
import { ChatStore, inboxItems, totalUnread, type Filtro, type Thread, type UiMessage } from "./chatStore";
import "./Chat.css";

type ChatProps = {
  token: string;
  mode: "mini" | "full";
  minimized: boolean;
  onClose: () => void;
  onExpand: () => void;
  onToggleMinimized: () => void;
  onLogout: () => void;
  onSessionExpired: () => void;
};

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: UiMessage; mine: boolean; first: boolean; seen: boolean; index: number };

const MAX_LENGTH = 4000;
const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const shortDayFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });

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

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(iso) === dayKey(now.toISOString())) return "Hoje";
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return "Ontem";
  return shortDayFormat.format(date).replace(".", "");
}

function listTime(iso: string): string {
  return dayKey(iso) === dayKey(new Date().toISOString())
    ? timeFormat.format(new Date(iso))
    : shortDayFormat.format(new Date(iso)).replace(".", "");
}

function isOwn(message: UiMessage, operator: boolean): boolean {
  return operator ? message.origem !== "usuario" : message.origem === "usuario";
}

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

function smoothScroll(element: HTMLElement, target: number, duration = 320) {
  const start = element.scrollTop;
  const distance = target - start;
  const startedAt = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    element.scrollTop = start + distance * (1 - (1 - progress) ** 3);
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function IconExpand() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

function IconBack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M15 5 8 12l7 7" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}

function LinkStatus({ link }: { link: "connecting" | "live" | "polling" }) {
  const label = link === "live" ? "Ao vivo" : link === "connecting" ? "Conectando" : "Atualizando";
  return <span className="chat-link" data-link={link} role="img" aria-label={label} title={label} />;
}

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
            <span className="chat-dot" aria-label={`${item.badge} não lidas`}>
              {item.badge > 9 ? "9+" : item.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="chat-skeleton" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

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

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!disabled && value.trim()) onSend();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const touchKeyboard = window.matchMedia("(pointer: coarse)").matches;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !touchKeyboard) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="chat-composer" onSubmit={submit}>
      <div className="chat-composer-field">
        <textarea
          ref={field}
          rows={1}
          value={value}
          maxLength={MAX_LENGTH}
          placeholder={placeholder}
          aria-label="Mensagem"
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
        aria-label="Enviar mensagem"
        onMouseDown={(event) => event.preventDefault()}
      >
        <IconSend />
      </button>
    </form>
  );
}

function MessageRow({
  row,
  onRetry,
  onDiscard,
}: {
  row: Extract<Row, { kind: "message" }>;
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
      {first && (
        <div className="chat-meta">
          {!mine && <span>{message.remetente.nome}</span>}
          <time dateTime={message.criada_em}>{timeFormat.format(new Date(message.criada_em))}</time>
        </div>
      )}
      <div className="chat-bubble">
        <p>{message.conteudo}</p>
      </div>
      {message.status === "enviando" && (
        <span className="chat-state" role="status">
          Enviando…
        </span>
      )}
      {message.status === "falhou" && (
        <span className="chat-state chat-state-error" role="alert">
          <span>{message.erro ?? "Não enviada."}</span>
          <button type="button" onClick={() => onRetry(message.id_cliente)}>
            Tentar de novo
          </button>
          <button type="button" onClick={() => onDiscard(message.id_cliente)}>
            Descartar
          </button>
        </span>
      )}
      {seen && !message.status && <span className="chat-state">Visto</span>}
    </div>
  );
}

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
  const ready = thread?.phase === "ready" && !!conversationId;
  const assistantNote =
    !operator && conversation?.destinatario === "assistente" && !profile.assistente_ia_ativo;

  useEffect(() => {
    const timer = window.setTimeout(() => setIntro(false), 1000);
    return () => window.clearTimeout(timer);
  }, []);

  useLayoutEffect(() => {
    const element = log.current;
    if (element && (stick.current || lastIsOwn)) element.scrollTop = element.scrollHeight;
  }, [lastKey, lastIsOwn, thread?.phase]);

  useLayoutEffect(() => {
    const element = log.current;
    if (element && anchor.current !== null) {
      element.scrollTop += element.scrollHeight - anchor.current;
      anchor.current = null;
    }
  }, [firstId]);

  const handleScroll = () => {
    const element = log.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
    stick.current = nearBottom;
    setAtBottom(nearBottom);
  };

  const loadOlder = () => {
    if (!conversationId) return;
    anchor.current = log.current?.scrollHeight ?? null;
    void store.loadOlder(conversationId);
  };

  const jumpToEnd = () => {
    const element = log.current;
    if (element) smoothScroll(element, element.scrollHeight - element.clientHeight);
  };

  const send = () => {
    if (!conversationId) return;
    stick.current = true;
    store.send(conversationId, draft);
    onDraft("");
  };

  return (
    <section className="chat-thread" aria-label={`Conversa com ${recipientName}`}>
      {onBack && (
        <div className="chat-thread-head">
          <button className="chat-back" type="button" onClick={onBack} aria-label="Voltar para a caixa de entrada">
            <IconBack />
            <span>Caixa de entrada</span>
          </button>
          <span className="chat-thread-name">{conversation?.usuario.username ?? recipientName}</span>
          {conversation && <span className="chat-tag">{conversation.nome_destinatario}</span>}
        </div>
      )}

      <div
        className="chat-log"
        ref={log}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        data-intro={intro}
        onScroll={handleScroll}
      >
        {assistantNote && (
          <p className="chat-note">
            O Assistente ainda não responde sozinho. Sua mensagem fica registrada e o Henrique pode
            responder por aqui.
          </p>
        )}

        {inboxError && (
          <div className="chat-state-box" role="alert">
            <p>{inboxError}</p>
            <button type="button" onClick={onRetryInbox}>
              TENTAR DE NOVO
            </button>
          </div>
        )}

        {!inboxError && !ready && thread?.phase !== "error" && <Skeleton />}

        {thread?.phase === "error" && conversationId && (
          <div className="chat-state-box" role="alert">
            <p>{thread.error}</p>
            <button type="button" onClick={() => void store.ensureThread(conversationId)}>
              TENTAR DE NOVO
            </button>
          </div>
        )}

        {ready && thread.olderNext && (
          <button className="chat-older" type="button" onClick={loadOlder} disabled={thread.loadingOlder}>
            {thread.loadingOlder ? "Carregando…" : "Mensagens anteriores"}
          </button>
        )}

        {ready && rows.length === 0 && (
          <div className="chat-empty">
            <p>Nenhuma mensagem ainda.</p>
            <p className="chat-empty-hint">
              {operator ? "Aguardando a primeira mensagem." : `Diga olá para ${recipientName}.`}
            </p>
          </div>
        )}

        {rows.map((row) =>
          row.kind === "day" ? (
            <div className="chat-day" key={row.key}>
              <span>{row.label}</span>
            </div>
          ) : (
            <MessageRow
              key={row.key}
              row={row}
              onRetry={(clientId) => conversationId && store.retry(conversationId, clientId)}
              onDiscard={(clientId) => conversationId && store.discard(conversationId, clientId)}
            />
          ),
        )}
      </div>

      {!atBottom && rows.length > 0 && (
        <button className="chat-jump" type="button" onClick={jumpToEnd}>
          Mais recentes <span aria-hidden="true">↓</span>
        </button>
      )}

      {operator && <p className="chat-hint">Respondendo como Henrique</p>}
      <Composer
        value={draft}
        disabled={!ready}
        placeholder={operator ? "Escreva uma resposta" : `Mensagem para ${recipientName}`}
        onChange={onDraft}
        onSend={send}
      />
    </section>
  );
}

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
      <div className="chat-state-box" role="alert">
        <p>{error}</p>
        <button type="button" onClick={onRetry}>
          TENTAR DE NOVO
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return loading || hasMore ? (
      <Skeleton />
    ) : (
      <div className="chat-empty">
        <p>Nenhuma conversa por aqui.</p>
        <p className="chat-empty-hint">As mensagens dos visitantes aparecem nesta lista.</p>
      </div>
    );
  }

  return (
    <ul className="chat-list">
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
                {fromMe ? "Você: " : ""}
                {last?.conteudo}
              </span>
              <span className="chat-list-tags">
                <span className="chat-tag">{item.nome_destinatario}</span>
                {item.nao_lidas > 0 && (
                  <span className="chat-dot" aria-label={`${item.nao_lidas} não lidas`}>
                    {item.nao_lidas > 9 ? "9+" : item.nao_lidas}
                  </span>
                )}
              </span>
            </button>
          </li>
        );
      })}
      {hasMore && (
        <li>
          <button className="chat-older" type="button" onClick={onMore} disabled={loading}>
            {loading ? "Carregando…" : "Ver mais conversas"}
          </button>
        </li>
      )}
    </ul>
  );
}

function Chat({
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

  const nameOf = (id: Destinatario) =>
    profile?.destinatarios.find((item) => item.id === id)?.nome ?? (id === "henrique" ? "Henrique" : "Assistente");
  const phraseOf = (id: Destinatario) => `${id === "assistente" ? "o " : ""}${nameOf(id)}`;
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

  const handleLogout = async () => {
    setLoggingOut(true);
    await store.logout();
    onLogout();
  };

  const retryInbox = () => store.clearInboxError(inbox);

  const headline = operator
    ? selectedId
      ? (currentConversation?.usuario.username ?? "Conversa")
      : "Caixa de entrada."
    : `Converse com ${phraseOf(inbox)}.`;
  const peek = operator
    ? selectedId
      ? (currentConversation?.usuario.username ?? "Conversa")
      : "Caixa de entrada"
    : nameOf(inbox);

  const draftKey = currentId ?? `inbox:${inbox}`;

  return (
    <div
      className="chat"
      data-mode={mode}
      data-minimized={minimized}
      data-operator={operator}
      data-state={state.phase}
    >
      <header className="chat-top">
        <div className="chat-id">
          <LinkStatus link={state.link} />
          {minimized ? (
            <span className="chat-peek">{peek}</span>
          ) : (
            <span className="chat-label">{operator ? "ATENDIMENTO" : "CONVERSA"}</span>
          )}
        </div>

        <div className="chat-actions">
          {mode === "mini" && minimized && unread > 0 && (
            <span className="chat-dot" aria-label={`${unread} não lidas`}>
              {unread > 9 ? "9+" : unread}
            </span>
          )}
          {mode === "mini" ? (
            <>
              <button
                className="chat-icon chat-toggle"
                type="button"
                onClick={onToggleMinimized}
                aria-label={minimized ? "Restaurar conversa" : "Minimizar conversa"}
                aria-expanded={!minimized}
                data-minimized={minimized}
              >
                <IconChevron />
              </button>
              <button className="chat-icon" type="button" onClick={onExpand} aria-label="Abrir conversa em tela cheia">
                <IconExpand />
              </button>
            </>
          ) : (
            <>
              <button className="chat-text-button" type="button" onClick={handleLogout} disabled={loggingOut}>
                {loggingOut ? "SAINDO…" : "SAIR"}
              </button>
              <button
                className="chat-icon chat-close"
                type="button"
                onClick={onClose}
                aria-label="Fechar janela de conversa"
              >
                <IconClose />
              </button>
            </>
          )}
        </div>
      </header>

      <div className="chat-body" aria-hidden={minimized} inert={minimized}>
        {mode === "full" && (
          <h2 className="chat-title" key={headline}>
            {headline}
          </h2>
        )}

        {state.phase === "loading" && <Skeleton />}

        {state.phase === "error" && (
          <div className="chat-state-box" role="alert">
            <p>{state.error}</p>
            <button type="button" onClick={() => store.reload()}>
              TENTAR DE NOVO
            </button>
          </div>
        )}

        {ready && !operator && (
          <>
            <Tabs
              label="Escolha com quem conversar"
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

        {ready && operator && !selectedId && (
          <>
            <Tabs
              label="Filtrar conversas"
              value={filter}
              onChange={setFilter}
              items={[
                { id: "todas", label: "Todas" },
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

        {ready && operator && selectedId && (
          <ThreadView
            key={selectedId}
            store={store}
            profile={profile}
            conversation={currentConversation}
            conversationId={selectedId}
            thread={state.threads[selectedId]}
            inboxError={undefined}
            recipientName={currentConversation?.usuario.username ?? "visitante"}
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

export default Chat;
