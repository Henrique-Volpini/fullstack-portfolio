import { useState } from "react";
import { flushSync } from "react-dom";

const THEMES = [
  { id: "noite", label: "Azul-noite" },
  { id: "cianotipo", label: "Cianótipo" },
  { id: "prancheta", label: "Prancheta" },
  { id: "anil", label: "Anil" },
] as const;

// Identificadores válidos de tema.
type ThemeId = (typeof THEMES)[number]["id"];

const THEME_STORAGE_KEY = "portfolio.theme";

// Lê o tema ativo no atributo data-theme do html, com Azul-noite como padrão.
function readTheme(): ThemeId {
  const current = THEMES.find((theme) => theme.id === document.documentElement.dataset.theme);
  return current?.id ?? "noite";
}

// Aplica o tema no html e o salva no localStorage; sem armazenamento, vale só até recarregar.
function applyTheme(id: ThemeId) {
  if (id === "noite") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
  }
}

// Botão que alterna entre os temas do site.
function ThemeToggle() {
  const [themeId, setThemeId] = useState<ThemeId>(readTheme);
  const index = THEMES.findIndex((theme) => theme.id === themeId);
  const current = THEMES[index];
  const next = THEMES[(index + 1) % THEMES.length];

  // Troca para o próximo tema, com transição de visualização quando o navegador suporta.
  const changeTheme = () => {
    // Aplica o tema e atualiza o estado de forma síncrona.
    const update = () =>
      flushSync(() => {
        applyTheme(next.id);
        setThemeId(next.id);
      });

    if ("startViewTransition" in document) document.startViewTransition(update);
    else update();
  };

  return (
    <button
      className="home-nav-link theme-toggle"
      type="button"
      onClick={changeTheme}
      aria-label={`Tema ${current.label}. Mudar para ${next.label}`}
      title={`Mudar para ${next.label}`}
    >
      <span
        className="theme-toggle-dot"
        style={{ background: `var(--swatch-${current.id})` }}
        aria-hidden="true"
      />
      {/* Rótulos de todos os temas sobrepostos, para o botão manter largura fixa. */}
      <span className="theme-toggle-label" aria-hidden="true">
        {THEMES.map((theme) => (
          <span key={theme.id} data-active={theme.id === themeId}>
            {theme.label}
          </span>
        ))}
      </span>
    </button>
  );
}

export default ThemeToggle;
