import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Chat from "../Chat/Chat";
import "./AuthPanel.css";

type AuthView = "login" | "cadastro";
type SubmitState = "idle" | AuthView;
type AuthNotice = { type: "error"; message: string };

const apiUrl = (import.meta.env.VITE_API_URL?.trim() || "/api").replace(/\/+$/, "");

async function sendAuthRequest(
  endpoint: "login" | "usuarios",
  data: { username: string; password: string; email?: string },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${apiUrl}/${endpoint}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(data),
    signal,
  });
  const result: unknown = await response.json().catch(() => null);
  signal.throwIfAborted();

  if (!response.ok) {
    if (response.status >= 500) {
      throw new Error("O servidor está indisponível. Tente novamente em instantes.");
    }

    const labels: Record<string, string> = {
      username: "Nome de usuário: ",
      email: "E-mail: ",
      password: "Senha: ",
      non_field_errors: "",
      erro: "",
      detail: "",
    };
    const messages = result && typeof result === "object"
      ? Object.entries(result).flatMap(([field, value]) => {
          if (!Object.hasOwn(labels, field)) return [];
          const errors: unknown[] = Array.isArray(value) ? value : [value];
          return errors
            .filter((error): error is string => typeof error === "string")
            .map((error) => `${labels[field]}${error}`);
        })
      : [];

    throw new Error(messages.join(" ") || "Não foi possível concluir a solicitação. Tente novamente.");
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("O servidor retornou uma resposta inválida. Tente novamente.");
  }

  return result as Record<string, unknown>;
}

function AuthPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<AuthView>("login");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [notice, setNotice] = useState<AuthNotice | null>(null);
  const [prefilledUsername, setPrefilledUsername] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const previousPosition = useRef<DOMRect | null>(null);
  const contentWasOpen = useRef(false);
  const request = useRef<AbortController | null>(null);
  const isAuthenticated = accessToken !== null;
  const isSubmitting = submitState === "login" || submitState === "cadastro";

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  useLayoutEffect(() => {
    const element = panel.current;
    const from = previousPosition.current;
    previousPosition.current = null;
    if (!element || !from) return;

    const to = element.getBoundingClientRect();
    const animation = element.animate(
      [
        { left: `${from.left}px`, top: `${from.top}px`, right: "auto", bottom: "auto", width: `${from.width}px`, height: `${from.height}px`, transform: "none" },
        { left: `${to.left}px`, top: `${to.top}px`, right: "auto", bottom: "auto", width: `${to.width}px`, height: `${to.height}px`, transform: "none" },
      ],
      {
        duration: isOpen ? 700 : 580,
        easing: "cubic-bezier(0.35, 0, 0.18, 1)",
      },
    );

    return () => animation.cancel();
  }, [isOpen]);

  useLayoutEffect(() => {
    const opening = isOpen && !contentWasOpen.current;
    contentWasOpen.current = isOpen;
    if (!isOpen || !panel.current) return;

    const elements = panel.current.querySelectorAll<HTMLElement>(
      ".auth-panel-heading, .auth-panel-field",
    );
    const animations = Array.from(elements, (element, index) => element.animate(
      [
        { opacity: 0, transform: `translate(${index === 0 ? 0 : view === "cadastro" ? 28 : -28}px, 16px)` },
        { opacity: 1, transform: "translate(0, 0)" },
      ],
      {
        duration: index === 0 ? 480 : 620,
        delay: (opening ? 360 : 0) + (index === 0 ? 0 : 70 + (index - 1) * 100),
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      },
    ));

    return () => animations.forEach((animation) => animation.cancel());
  }, [isOpen, view, isAuthenticated]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    const trigger = openButton.current;
    document.body.style.overflow = "hidden";
    const page = document.querySelectorAll(".home-header, .home");
    page.forEach((element) => element.setAttribute("inert", ""));
    const focusTimer = window.setTimeout(() => {
      if (document.activeElement === trigger || !panel.current?.contains(document.activeElement)) {
        closeButton.current?.focus();
      }
    }, 700);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      page.forEach((element) => element.removeAttribute("inert"));
      trigger?.focus();
    };
  }, [isOpen]);

  const openPanel = () => {
    previousPosition.current = panel.current?.getBoundingClientRect() ?? null;
    setView("login");
    setSubmitState("idle");
    setNotice(null);
    setPrefilledUsername("");
    panel.current?.querySelector<HTMLFormElement>("form")?.reset();
    setIsOpen(true);
  };

  const closePanel = () => {
    request.current?.abort();
    request.current = null;
    setSubmitState("idle");
    setNotice(null);
    panel.current?.querySelector<HTMLFormElement>("form")?.reset();
    previousPosition.current = panel.current?.getBoundingClientRect() ?? null;
    setIsOpen(false);
  };

  const changeView = (nextView: AuthView) => {
    if (isAuthenticated || isSubmitting || nextView === view) return;
    setView(nextView);
    setSubmitState("idle");
    setNotice(null);
    setPrefilledUsername("");
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!isOpen) return;

    if (event.key === "Escape") {
      closePanel();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = panel.current?.querySelectorAll<HTMLElement>(
      '.auth-panel-dialog button:not([disabled]), .auth-panel-dialog input:not([disabled])',
    );
    if (!focusable?.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (request.current || isAuthenticated) return;

    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const fields = new FormData(form);
    let username = String(fields.get("username") ?? "").trim();
    const password = String(fields.get("password") ?? "");
    if (!username || !password) {
      setNotice({ type: "error", message: "Preencha o nome de usuário e a senha." });
      return;
    }

    const controller = new AbortController();
    request.current = controller;
    setSubmitState(view);
    setNotice(null);
    let accountCreated = false;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 15000);

    try {
      if (view === "cadastro") {
        const account = await sendAuthRequest("usuarios", {
          username,
          password,
          email: String(fields.get("email") ?? "").trim(),
        }, controller.signal);
        accountCreated = true;
        if (typeof account.username === "string") username = account.username;
        if (request.current !== controller) return;
        setSubmitState("login");
      }

      const login = await sendAuthRequest("login", { username, password }, controller.signal);
      if (request.current !== controller) return;
      if (typeof login.token !== "string" || !login.token.trim()) {
        throw new Error("O servidor não confirmou o login. Tente novamente.");
      }

      form.reset();
      setAccessToken(login.token);
      setSubmitState("idle");
      setNotice(null);
      closeButton.current?.focus();
    } catch (error) {
      if (request.current !== controller) return;
      const message = timedOut
        ? "O servidor demorou para responder. Tente novamente."
        : error instanceof TypeError
          ? "Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente."
          : error instanceof Error ? error.message : "Não foi possível concluir a solicitação.";

      setSubmitState("idle");
      if (accountCreated) {
        setPrefilledUsername(username);
        setView("login");
      }
      setNotice({
        type: "error",
        message: accountCreated
          ? `Sua conta foi criada, mas o login automático não foi concluído. ${message} Faça login para continuar.`
          : view === "cadastro" && (timedOut || error instanceof TypeError)
            ? `${message} Se a conta já tiver sido criada, tente fazer login.`
            : message,
      });
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) request.current = null;
    }
  };

  return (
    <>
      <div
        className="auth-backdrop"
        data-open={isOpen}
        aria-hidden="true"
        onClick={closePanel}
      />

      <section
        className="auth-panel"
        data-open={isOpen}
        data-view={view}
        data-pending={isSubmitting}
        role={isOpen ? "dialog" : undefined}
        aria-modal={isOpen ? true : undefined}
        aria-labelledby={isOpen && !isAuthenticated ? "auth-title" : undefined}
        aria-label={isOpen && isAuthenticated ? "Chat" : undefined}
        ref={panel}
        onKeyDown={handleKeyDown}
      >
        <div className="auth-panel-preview" aria-hidden={isOpen} inert={isOpen}>
          <span className="auth-panel-label">CONVERSA</span>
          <div className="auth-panel-preview-content">
            {!isAuthenticated && <h2>Faça login para conversar com o Henrique.</h2>}
          </div>
          <button
            className="auth-panel-open"
            type="button"
            onClick={openPanel}
            ref={openButton}
          >
            {isAuthenticated ? "Abrir chat" : "Criar conta / Login"} <span aria-hidden="true">→</span>
          </button>
        </div>

        <div className="auth-panel-dialog" aria-hidden={!isOpen} inert={!isOpen}>
          <div className="auth-panel-topline">
            <span>{isAuthenticated ? "CONVERSA" : "ACESSO / CONVERSA"}</span>
            <button
              className="auth-panel-close"
              type="button"
              aria-label={isAuthenticated ? "Fechar janela de conversa" : "Fechar janela de login e cadastro"}
              onClick={closePanel}
              ref={closeButton}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          {isAuthenticated ? <Chat /> : (
            <>
              <div className="auth-panel-heading" key={view}>
                <h2 id="auth-title">{view === "login" ? "Entre para conversar." : "Crie sua conta."}</h2>
                <p className="auth-panel-description">
                  {view === "login"
                    ? "Entre na sua conta para começar a conversa."
                    : "Escolha um usuário e uma senha para começar."}
                </p>
              </div>

              <div className="auth-panel-tabs" aria-label="Escolha entre login e cadastro">
                <button
                  type="button"
                  aria-pressed={view === "login"}
                  disabled={isSubmitting}
                  onClick={() => changeView("login")}
                >
                  Fazer login
                </button>
                <button
                  type="button"
                  aria-pressed={view === "cadastro"}
                  disabled={isSubmitting}
                  onClick={() => changeView("cadastro")}
                >
                  Criar conta
                </button>
              </div>

              <form className="auth-panel-form" onSubmit={handleSubmit} aria-busy={isSubmitting}>
                <div className="auth-panel-fields" key={view}>
                  <div className="auth-panel-field">
                    <label htmlFor="auth-username">Nome de usuário</label>
                    <input
                      id="auth-username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      maxLength={150}
                      defaultValue={prefilledUsername}
                      placeholder="Seu usuário"
                      disabled={isSubmitting}
                      required
                    />
                  </div>

                  <div className="auth-panel-field">
                    <label htmlFor="auth-password">Senha</label>
                    <input
                      id="auth-password"
                      name="password"
                      type="password"
                      autoComplete={view === "login" ? "current-password" : "new-password"}
                      maxLength={64}
                      placeholder="Sua senha"
                      disabled={isSubmitting}
                      required
                    />
                  </div>

                  <div className="auth-panel-field auth-panel-email" aria-hidden={view !== "cadastro"} inert={view !== "cadastro"}>
                    <label htmlFor="auth-email">E-mail <span>(opcional)</span></label>
                    <input
                      id="auth-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      placeholder="voce@exemplo.com"
                      disabled={view !== "cadastro" || isSubmitting}
                    />
                  </div>
                </div>

                <div className="auth-panel-actions">
                  <button className="auth-panel-submit" type="submit" disabled={isSubmitting}>
                    <span className="auth-panel-submit-label" key={`${view}-${submitState}`}>
                      {submitState === "cadastro" ? "Criando conta…"
                        : submitState === "login" ? "Entrando…"
                          : view === "login" ? "Entrar" : "Criar conta"}
                    </span>
                    {isSubmitting ? (
                      <svg className="auth-panel-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="42 15" strokeLinecap="round" />
                      </svg>
                    ) : <span className="auth-panel-arrow" aria-hidden="true">→</span>}
                  </button>
                  <div className="auth-panel-feedback">
                    {isSubmitting && <p className="auth-panel-wait" role="status">Aguarde, estamos {submitState === "cadastro" ? "criando sua conta" : "confirmando seu acesso"}…</p>}
                    {notice && (
                      <p className="auth-panel-notice" data-type={notice.type} role="alert">
                        {notice.message}
                      </p>
                    )}
                  </div>
                </div>
              </form>
            </>
          )}
        </div>
      </section>
    </>
  );
}

export default AuthPanel;
