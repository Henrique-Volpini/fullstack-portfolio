import { useEffect, useRef, useState } from "react";

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

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

const CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const SCRIPT_URL = "https://accounts.google.com/gsi/client";
const SCRIPT_TIMEOUT = 10000;
// Limites de largura aceitos pelo botão do Google.
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

let loading: Promise<GoogleIdentity> | null = null;
let initialized = false;
let credentialHandler: ((credential: string) => void) | null = null;

function loadGoogleIdentity(): Promise<GoogleIdentity> {
  loading ??= new Promise<GoogleIdentity>((resolve, reject) => {
    const loaded = window.google?.accounts?.id;
    if (loaded) {
      resolve(loaded);
      return;
    }

    const script = document.createElement("script");
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

// O Google avisa quando initialize() roda mais de uma vez; por isso ele é chamado uma só vez
// e a resposta segue para quem estiver montado no momento.
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

type GoogleSignInProps = {
  active: boolean;
  disabled: boolean;
  mode: "login" | "cadastro";
  onCredential: (credential: string) => void;
};

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
        locale: "pt-BR",
      });
    };
    // O painel muda de tamanho ao abrir; só desenha o botão quando a largura estabiliza.
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

  const retry = () => {
    setFailed(false);
    setAttempt((value) => value + 1);
  };

  if (!CLIENT_ID) return null;

  return (
    <div className="auth-panel-google" data-disabled={disabled}>
      <div className="auth-panel-google-slot">
        <div className="auth-panel-google-button" ref={button} />
        {!identity && (failed ? (
          <p className="auth-panel-google-status" role="alert">
            Não foi possível carregar o login do Google.{" "}
            <button type="button" onClick={retry}>Tentar de novo</button>
          </p>
        ) : (
          <p className="auth-panel-google-status" role="status">Carregando o login do Google…</p>
        ))}
      </div>
      <p className="auth-panel-divider" aria-hidden="true"><span>ou</span></p>
    </div>
  );
}

export default GoogleSignIn;
