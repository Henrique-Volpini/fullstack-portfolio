import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type TransitionEvent } from "react";
import banestesLogo from "../../assets/banestes-logo.png";
import profilePhoto from "../../assets/perfil-henrique.webp";
import { texts } from "../../texts";
import AuthPanel from "../Auth/AuthPanel";
import CopyLinkButton from "./CopyLinkButton";
import PrivacyNotice from "./PrivacyNotice";
import ThemeToggle from "./ThemeToggle";
import "../../styles/theme.css";
import "../../styles/global.css";
import "./Home.css";

// Identificadores das seções do Sobre mim.
type AboutSectionId = "profile" | "education" | "work" | "focus";

// Conteúdo de uma seção do Sobre mim: textos, detalhes e, se houver, o logo da empresa.
type AboutSection = {
  id: AboutSectionId;
  label: string;
  paragraphs: string[];
  details: Array<{ term: string; description: string }>;
  showBanestesLogo?: boolean;
};

// Seções do Sobre mim, na ordem das abas; os textos ficam em src/texts.ts.
const aboutSections: AboutSection[] = (["profile", "education", "work", "focus"] as const).map((id) => ({
  id,
  ...texts.about.sections[id],
  showBanestesLogo: id === "work",
}));

// Corpo de uma seção do Sobre mim: logo opcional, parágrafos e quadro de detalhes.
function AboutBody({ section }: { section: AboutSection }) {
  return (
    <>
      {/* Logo da empresa atual, só na seção de trabalho. */}
      {section.showBanestesLogo && (
        <div className="about-company">
          <img
            src={banestesLogo}
            alt={texts.about.companyLogoAlt}
            width="805"
            height="823"
            loading="lazy"
          />
          <span>{texts.about.companyCaption}</span>
        </div>
      )}

      {/* Parágrafos da seção. */}
      <div className="about-text">
        {section.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>

      {/* Quadro com os detalhes em formato de lista. */}
      <div className="about-details-frame">
        <dl className="about-details">
          {section.details.map((detail) => (
            <div key={detail.term}>
              <dt>{detail.term}</dt>
              <dd>{detail.description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}

let scrollFrame = 0;

// Rola a página até a posição com animação própria, interrompida se o usuário rolar ou digitar.
function scrollToY(targetY: number) {
  cancelAnimationFrame(scrollFrame);

  const startY = window.scrollY;
  const distance = targetY - startY;

  if (Math.abs(distance) < 2) {
    window.scrollTo({ top: targetY, behavior: "instant" });
    return;
  }

  const duration = Math.min(1100, Math.max(450, Math.abs(distance) * 0.55));
  const startTime = performance.now();
  const interruptions = ["wheel", "touchstart", "keydown"] as const;

  // Cancela a animação e remove os ouvintes de interrupção.
  const stop = () => {
    cancelAnimationFrame(scrollFrame);
    interruptions.forEach((type) => window.removeEventListener(type, stop));
  };
  interruptions.forEach((type) => window.addEventListener(type, stop, { passive: true }));

  // Avança um quadro da rolagem com aceleração e desaceleração suaves.
  const step = (now: number) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const eased =
      progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    window.scrollTo({ top: startY + distance * eased, behavior: "instant" });

    if (progress < 1) scrollFrame = requestAnimationFrame(step);
    else stop();
  };
  scrollFrame = requestAnimationFrame(step);
}

// Página inicial: cabeçalho, apresentação, sobre mim, stack, contato, rodapé e o painel de chat.
function Home() {
  const [activeAbout, setActiveAbout] = useState<AboutSectionId>("profile");
  const [displayedAbout, setDisplayedAbout] = useState<AboutSectionId>("profile");
  const [detailsPhase, setDetailsPhase] = useState<"idle" | "closing" | "opening">("idle");
  const requestedAbout = useRef<AboutSectionId>("profile");
  const [hoveredStack, setHoveredStack] = useState<number | null>(null);
  const [focusedStack, setFocusedStack] = useState<number | null>(null);
  const activeStack = hoveredStack ?? focusedStack;
  const currentAbout =
    aboutSections.find((section) => section.id === displayedAbout) ?? aboutSections[0];

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.revealed = "true";
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: "0px 0px -40px 0px" },
    );

    document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((el) => {
      observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const header = document.querySelector<HTMLElement>(".home-header");
    const onScroll = () => {
      header?.setAttribute("data-scrolled", String(window.scrollY > 24));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Seleciona uma seção do Sobre mim e inicia a troca animada.
  const selectAbout = (sectionId: AboutSectionId) => {
    if (sectionId === requestedAbout.current) return;

    requestedAbout.current = sectionId;
    setActiveAbout(sectionId);
    if (detailsPhase === "idle") setDetailsPhase("closing");
  };

  // Conduz as fases da troca de seção: fecha, troca o conteúdo e reabre.
  const handleAboutTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "clip-path") return;

    if (detailsPhase === "closing") {
      setDisplayedAbout(requestedAbout.current);
      setDetailsPhase("opening");
    } else if (detailsPhase === "opening") {
      setDetailsPhase(requestedAbout.current === displayedAbout ? "idle" : "closing");
    }
  };

  // Rola até uma seção respeitando o cabeçalho fixo e leva o foco a ela.
  const scrollToSection = (sectionId: string) => {
    const section = document.getElementById(sectionId);
    if (!section) return;

    const offset = parseFloat(getComputedStyle(section).scrollMarginTop) || 0;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    let sectionTop = 0;
    for (let el: HTMLElement | null = section; el; el = el.offsetParent as HTMLElement | null) {
      sectionTop += el.offsetTop;
    }
    const target = sectionTop - offset;

    scrollToY(Math.min(Math.max(0, target), maxScroll));
    section.focus({ preventScroll: true });
  };

  // Navegação por teclado nas abas do Sobre mim (setas, Home e End).
  const handleAboutTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const lastIndex = aboutSections.length - 1;
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    const nextSection = aboutSections[nextIndex];
    selectAbout(nextSection.id);
    document.getElementById(`about-tab-${nextSection.id}`)?.focus();
  };

  return (
    <>
      {/* Cabeçalho fixo com logo e navegação. */}
      <header className="home-header">
        <nav className="home-nav home-container" aria-label={texts.header.navLabel}>
          <button
            className="home-logo"
            type="button"
            onClick={() => scrollToSection("inicio")}
            aria-label={texts.header.logoLabel}
          >
            <span aria-hidden="true">&lt;</span>
            {texts.header.logo}
            <span aria-hidden="true"> /&gt;</span>
          </button>

          {/* Links de navegação por seção e botão de tema. */}
          <div className="home-nav-links">
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("inicio")}
            >
              {texts.header.links.inicio}
            </button>
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("about")}
            >
              {texts.header.links.about}
            </button>
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("stack")}
            >
              {texts.header.links.stack}
            </button>
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("contato")}
            >
              {texts.header.links.contato}
            </button>
            <ThemeToggle />
          </div>
        </nav>
      </header>

      {/* Conteúdo da página. */}
      <main className="home">
        {/* Apresentação: nome, descrição e foto. */}
        <section
          className="home-hero home-container"
          id="inicio"
          aria-labelledby="home-title"
          tabIndex={-1}
        >
          {/* Texto da apresentação. */}
          <div className="hero-content">
            <span className="hero-eyebrow">{texts.hero.eyebrow}</span>

            <h1 className="hero-title" id="home-title">
              <span>{texts.hero.firstName}</span>
              <span className="hero-title-last">{texts.hero.lastName}</span>
            </h1>

            <p className="hero-description">{texts.hero.description}</p>

            <p className="hero-technologies">
              {/* Repete a divisão de espaços do texto original, para o espaçamento entre as palavras não mudar. */}
              {texts.hero.technologies.map((technology, index, list) => (
                <Fragment key={technology}>
                  {index > 0 && <span aria-hidden="true">·</span>}
                  {index === 0 ? `${technology} ` : ` ${technology}`}
                  {index > 0 && index < list.length - 1 && " "}
                </Fragment>
              ))}
            </p>
          </div>

          {/* Foto de perfil com moldura. */}
          <div className="hero-photo-wrapper">
            <div className="hero-photo-frame">
              <img
                className="hero-photo-image"
                src={profilePhoto}
                alt={texts.hero.photoAlt}
                width="800"
                height="800"
              />
            </div>
          </div>
        </section>

        {/* Sobre mim: abas de tópicos e conteúdo com troca animada. */}
        <section
          className="home-about home-container"
          id="about"
          aria-labelledby="about-title"
          tabIndex={-1}
        >
          {/* Título e abas de tópicos. */}
          <div className="about-heading">
            <span className="about-index" aria-hidden="true">
              01
            </span>
            <span className="about-label" aria-hidden="true">
              {texts.about.eyebrow} / {currentAbout.label}
            </span>
            <h2 id="about-title">{texts.about.title}</h2>

            {/* Abas dos tópicos, navegáveis pelo teclado. */}
            <div className="about-tabs" role="tablist" aria-label={texts.about.tabsLabel}>
              {aboutSections.map((section, index) => (
                <button
                  className="about-tab"
                  type="button"
                  key={section.id}
                  id={`about-tab-${section.id}`}
                  role="tab"
                  aria-selected={activeAbout === section.id}
                  aria-controls="about-panel"
                  tabIndex={activeAbout === section.id ? 0 : -1}
                  onClick={() => selectAbout(section.id)}
                  onKeyDown={(event) => handleAboutTabKeyDown(event, index)}
                >
                  <span aria-hidden="true">0{index + 1}</span>
                  {section.label}
                </button>
              ))}
            </div>
          </div>

          {/* Painel do tópico selecionado. */}
          <div
            className="about-content"
            id="about-panel"
            role="tabpanel"
            aria-labelledby={`about-tab-${currentAbout.id}`}
            tabIndex={0}
          >
            {/* Área da troca animada de conteúdo, na altura do maior tópico. */}
            <div className="about-reveal" data-phase={detailsPhase}>
              {/* Conteúdo visível do tópico atual. */}
              <div className="about-reveal-content" onTransitionEnd={handleAboutTransitionEnd}>
                <AboutBody section={currentAbout} />
              </div>

              {/* Cópias invisíveis de todos os tópicos que reservam a altura e evitam saltos no layout. */}
              {aboutSections.map((section) => (
                <div className="about-sizer" key={section.id} aria-hidden="true" inert>
                  <AboutBody section={section} />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Stack: tecnologias com descrição ao passar o mouse ou focar. */}
        <section
          className="home-stack home-container"
          id="stack"
          aria-labelledby="stack-title"
          tabIndex={-1}
          data-reveal=""
        >
          <div className="section-heading">
            <span aria-hidden="true">02</span>
            <h2 id="stack-title">{texts.stack.title}</h2>
          </div>

          {/* Lista de tecnologias. */}
          <ul className="stack-list">
            {texts.stack.technologies.map((technology, index) => (
              <li
                className="stack-item"
                key={technology.name}
                tabIndex={0}
                data-active={activeStack === index}
                aria-describedby={`stack-description-${index}`}
                onMouseEnter={() => setHoveredStack(index)}
                onMouseLeave={() => setHoveredStack(null)}
                onFocus={() => setFocusedStack(index)}
                onBlur={() => setFocusedStack(null)}
              >
                <span className="stack-name">{technology.name}</span>
                <span
                  className="stack-description"
                  id={`stack-description-${index}`}
                  role="tooltip"
                  data-open={activeStack === index}
                  data-dismissed={activeStack !== null && activeStack !== index}
                  aria-hidden={activeStack !== index}
                >
                  <span className="stack-description-content">
                    <span>{technology.description}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Contato: links diretos e currículo. */}
        <section
          className="home-contact home-container"
          id="contato"
          aria-labelledby="contact-title"
          tabIndex={-1}
          data-reveal=""
        >
          <div className="section-heading">
            <span aria-hidden="true">03</span>
            <h2 id="contact-title">{texts.contact.title}</h2>
          </div>

          {/* Introdução e lista de contatos lado a lado. */}
          <div className="contact-layout">
            <div className="contact-intro">
              <p className="contact-eyebrow">{texts.contact.eyebrow}</p>
              <p className="contact-title">{texts.contact.heading}</p>
              <p className="contact-description">{texts.contact.description}</p>
            </div>

            {/* Links de contato, cada um com botão para copiar. */}
            <ul className="contact-links">
              <li>
                <CopyLinkButton value="https://github.com/Henrique-Volpini" label={texts.contact.github.copy} />
                <a
                  href="https://github.com/Henrique-Volpini"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={texts.contact.github.label}
                >
                  <span>
                    <small>{texts.contact.github.kind}</small>
                    Henrique-Volpini
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <CopyLinkButton
                  value="https://www.linkedin.com/in/henrique-volpini-gon%C3%A7alves-72aa55366/"
                  label={texts.contact.linkedin.copy}
                />
                <a
                  href="https://www.linkedin.com/in/henrique-volpini-gon%C3%A7alves-72aa55366/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={texts.contact.linkedin.label}
                >
                  <span>
                    <small>{texts.contact.linkedin.kind}</small>
                    Henrique Volpini Gonçalves
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <CopyLinkButton value="https://wa.me/5527997899584" label={texts.contact.whatsapp.copy} />
                <a
                  href="https://wa.me/5527997899584"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={texts.contact.whatsapp.label}
                >
                  <span>
                    <small>{texts.contact.whatsapp.kind}</small>
                    +55 27 99789-9584
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <CopyLinkButton value="henriquev.comp@gmail.com" label={texts.contact.email.copy} />
                <a
                  href="mailto:henriquev.comp@gmail.com"
                  aria-label={texts.contact.email.label}
                >
                  <span>
                    <small>{texts.contact.email.kind}</small>
                    henriquev.comp@gmail.com
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <CopyLinkButton
                  value={new URL(`${import.meta.env.BASE_URL}curriculo-henrique-volpini.pdf`, window.location.origin).href}
                  label={texts.contact.resume.copy}
                />
                <a
                  href={`${import.meta.env.BASE_URL}curriculo-henrique-volpini.pdf`}
                  download="curriculo-henrique-volpini.pdf"
                >
                  <span>
                    <small>{texts.contact.resume.kind}</small>
                    {texts.contact.resume.action}
                  </span>
                  <span aria-hidden="true">↓</span>
                </a>
              </li>
            </ul>
          </div>
        </section>

        {/* Rodapé com direitos autorais e aviso de privacidade. */}
        <footer className="home-footer home-container">
          <p className="home-footer-note">{texts.footer.copyright(new Date().getFullYear())}</p>
          <PrivacyNotice />
        </footer>
      </main>
      <AuthPanel />
    </>
  );
}

export default Home;
