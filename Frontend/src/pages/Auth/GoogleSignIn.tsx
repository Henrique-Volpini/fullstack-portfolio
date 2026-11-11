import { useEffect, useRef, useState } from "react";
import { texts } from "../../texts";

// Parte da API do Google Identity Services usada pelo botão.
type GoogleIdentity = {
  initialize: (config: {
    client_id: string;
    callback: (response: { credential?: unknown }) => void;
  }) => void;
  renderButton: (
    parent: HTMLElement,
    options: {
      type: "standard";
      theme: "outline" | "filled_black";
      size: "large";
      text: "signin_with" | "signup_with";
      shape: "rectangular";
      logo_alignment: "left";
      width: number;
      locale: string;
    },
  ) => void;
};

// Declara window.google, criado pelo script do Google.
declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

const CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const SCRIPT_URL = "https://accounts.google.com/gsi/client";
const SCRIPT_TIMEOUT = 10000;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

let loading: Promise<GoogleIdentity> | null = null;
let initialized = false;
let credentialHandler: ((credential: string) => void) | null = null;

// Carrega o script do Google uma única vez, com prazo de 10 s, e devolve a API.
function loadGoogleIdentity(): Promise<GoogleIdentity> {
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const loaded = window.google?.accounts?.id;
    if (loaded) {
      resolve(loaded);
      return;
    }

    const script = document.createElement("script");
    // Cancela o carregamento: remove o script, libera nova tentativa e rejeita a promessa.
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      loading = null;
      reject(new Error("Falha ao carregar o script do Google."));
    };
    const timer = window.setTimeout(fail, SCRIPT_TIMEOUT);
    script.onload = () => {
      window.clearTimeout(timer);
      const identity = window.google?.accounts?.id;
      if (identity) resolve(identity);
      else fail();
    };
    script.onerror = fail;
    script.src = SCRIPT_URL;
    script.async = true;
    document.head.append(script);
  });
  return loading;
}

// Inicializa o Google uma só vez (ele avisa se repetir) e entrega a credencial a quem estiver montado.
function initialize(identity: GoogleIdentity) {
  if (initialized) return;
  identity.initialize({
    client_id: CLIENT_ID,
    callback: (response) => {
      credentialHandler?.(typeof response?.credential === "string" ? response.credential : "");
    },
  });
  initialized = true;
}

// Propriedades: painel ativo, desabilitado, modo (login ou cadastro) e callback da credencial.
type GoogleSignInProps = {
  active: boolean;
  disabled: boolean;
  mode: "login" | "cadastro";
  onCredential: (credential: string) => void;
};

// Botão de login com Google: carrega o script, desenha o botão na largura do painel e entrega a credencial.
function GoogleSignIn({ active, disabled, mode, onCredential }: GoogleSignInProps) {
  const [identity, setIdentity] = useState<GoogleIdentity | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const button = useRef<HTMLDivElement>(null);

  useEffect(() => {
    credentialHandler = onCredential;
    return () => {
      if (credentialHandler === onCredential) credentialHandler = null;
    };
  }, [onCredential]);

  useEffect(() => {
    if (!CLIENT_ID || !active || identity) return;

    let cancelled = false;
    loadGoogleIdentity().then(
      (loaded) => {
        if (cancelled) return;
        initialize(loaded);
        setIdentity(loaded);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, identity, attempt]);

  useEffect(() => {
    const container = button.current;
    if (!active || !identity || !container) return;

    let width = 0;
    let timer = 0;
    // Redesenha o botão do Google na largura do contêiner, entre 200 e 400 px.
    const draw = () => {
      const next = Math.min(MAX_WIDTH, Math.floor(container.clientWidth));
      if (next < MIN_WIDTH || next === width) return;
      width = next;
      container.replaceChildren();
      identity.renderButton(container, {
        type: "standard",
        theme: document.documentElement.dataset.theme === "prancheta" ? "outline" : "filled_black",
        size: "large",
        text: mode === "login" ? "signin_with" : "signup_with",
        shape: "rectangular",
        logo_alignment: "left",
        width,
        locale: texts.locale,
      });
    };
    // Adia o desenho até a largura estabilizar, pois o painel muda de tamanho ao abrir.
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(draw, 200);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(container);

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      container.replaceChildren();
    };
  }, [active, identity, mode]);

  // Tenta carregar o script do Google de novo depois de uma falha.
  const retry = () => {
    setFailed(false);
    setAttempt((value) => value + 1);
  };

  if (!CLIENT_ID) return null;

  return (
    // Bloco do login com Google: botão (ou aviso de status) e divisor.
    <div className="auth-panel-google" data-disabled={disabled}>
      {/* Espaço do botão do Google e das mensagens de carregamento ou erro. */}
      <div className="auth-panel-google-slot">
        {/* Contêiner onde o Google desenha o botão. */}
        <div className="auth-panel-google-button" ref={button} />
        {/* Status enquanto o Google não carregou: erro com nova tentativa ou aviso de carregamento. */}
        {!identity && (failed ? (
          <p className="auth-panel-google-status" role="alert">
            {texts.auth.google.loadFailed}{" "}
            <button type="button" onClick={retry}>{texts.auth.google.retry}</button>
          </p>
        ) : (
          <p className="auth-panel-google-status" role="status">{texts.auth.google.loading}</p>
        ))}
      </div>
      <p className="auth-panel-divider" aria-hidden="true"><span>{texts.auth.google.divider}</span></p>
    </div>
  );
}

export default GoogleSignIn;
