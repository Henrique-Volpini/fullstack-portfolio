import { useRef, useState, type KeyboardEvent, type TransitionEvent } from "react";
import banestesLogo from "../../assets/banestes-logo.png";
import profilePhoto from "../../assets/perfil-henrique.webp";
import "../../styles/theme.css";
import "../../styles/global.css";
import "./Home.css";

type AboutSectionId = "profile" | "education" | "work" | "focus";

type AboutSection = {
  id: AboutSectionId;
  label: string;
  paragraphs: string[];
  details: Array<{ term: string; description: string }>;
  showBanestesLogo?: boolean;
};

const aboutSections: AboutSection[] = [
  {
    id: "profile",
    label: "Perfil",
    paragraphs: [
      "Sou estudante de Ciência da Computação na FAESA e atualmente estagiário no Banestes, onde tenho contato direto com o ambiente de tecnologia e com problemas reais do dia a dia de TI.",
      "Tenho interesse principalmente em desenvolvimento Full-Stack, trabalhando com Python, Django, Django REST Framework, TypeScript e JavaScript para construir aplicações web e APIs.",
      "Também utilizo programação para automatizar processos e reduzir tarefas repetitivas, com ferramentas como Python, Power Automate e Excel voltadas à automação e otimização de atividades.",
      "Além do desenvolvimento web, tenho interesse em arquitetura de software, inteligência artificial, desenvolvimento de jogos e novas tecnologias. Parte do meu aprendizado acontece em projetos pessoais, nos quais estudo ferramentas e transformo ideias em aplicações.",
    ],
    details: [
      { term: "Formação", description: "Ciência da Computação — FAESA" },
      { term: "Atualmente", description: "Estagiário — Banestes" },
      { term: "Foco", description: "Desenvolvimento Full-Stack" },
      { term: "Base", description: "Python / Django / TypeScript" },
    ],
  },
  {
    id: "education",
    label: "Formação",
    paragraphs: [
      "Ingressei no curso de Ciência da Computação na FAESA no início de 2022 e atualmente estou na etapa final da graduação.",
      "Ao longo do curso, tive contato com Python e Java e desenvolvi uma base em algoritmos, estruturas de dados, orientação a objetos, bancos de dados e engenharia de software.",
      "A formação também me apresentou fundamentos de redes, sistemas operacionais e arquitetura de computadores, ajudando a entender como as diferentes partes de um sistema se conectam.",
      "Procuro levar esses conceitos para a prática em projetos pessoais e no trabalho, usando o desenvolvimento de software como forma de consolidar o aprendizado.",
    ],
    details: [
      { term: "Início", description: "2022" },
      { term: "Curso", description: "Ciência da Computação" },
      { term: "Instituição", description: "FAESA" },
      { term: "Situação", description: "Em fase de conclusão" },
    ],
  },
  {
    id: "work",
    label: "Trabalho atual",
    paragraphs: [
      "No Banestes, atuo como estagiário de desenvolvimento Full-Stack, utilizando Django como principal ferramenta no dia a dia.",
      "Trabalho no desenvolvimento de um site de uso interno criado para facilitar a integração entre grupos e tornar o acesso e o uso das informações mais diretos.",
      "A rotina envolve tanto o backend quanto a interface da aplicação, com uso cotidiano de Django, JavaScript, HTML e CSS.",
      "Essa experiência me permite aprender a partir de necessidades reais, entender melhor a organização de uma aplicação e buscar formas mais simples de apoiar processos internos com software.",
    ],
    details: [
      { term: "Empresa", description: "Banestes" },
      { term: "Função", description: "Estagiário de desenvolvimento Full-Stack" },
      { term: "Principal ferramenta", description: "Django" },
      { term: "Produto", description: "Aplicação web interna" },
    ],
    showBanestesLogo: true,
  },
  {
    id: "focus",
    label: "Foco",
    paragraphs: [
      "Meu foco atual é desenvolvimento Full-Stack: entender o problema, estruturar o backend e construir uma interface clara para quem vai utilizar a aplicação.",
      "Tenho buscado evoluir principalmente em Python, Django, APIs, TypeScript e arquitetura de software, conectando esses conhecimentos em aplicações completas.",
      "Também mantenho interesse em automação, inteligência artificial, desenvolvimento de jogos e novas tecnologias como caminhos complementares de estudo.",
    ],
    details: [
      { term: "Área", description: "Desenvolvimento Full-Stack" },
      { term: "Backend", description: "Python / Django / APIs" },
      { term: "Frontend", description: "TypeScript / JavaScript" },
      { term: "Objetivo", description: "Construir aplicações completas" },
    ],
  },
];

const technologies = [
  {
    name: "Python",
    description:
      "Minha base para backend e automações. Comecei na graduação e continuei praticando no trabalho e em projetos pessoais.",
  },
  {
    name: "Django",
    description:
      "Minha principal ferramenta no Banestes, utilizada cotidianamente no desenvolvimento da aplicação web interna.",
  },
  {
    name: "Django REST Framework",
    description:
      "Biblioteca escolhida e já instalada neste portfólio para estruturar a API que conectará o backend Django ao frontend.",
  },
  {
    name: "TypeScript",
    description:
      "Utilizado no frontend deste portfólio para escrever componentes React com tipos mais seguros.",
  },
  {
    name: "JavaScript",
    description:
      "Usado cotidianamente no Banestes para implementar comportamentos e interações na interface da aplicação interna.",
  },
  {
    name: "HTML",
    description:
      "Usado cotidianamente no trabalho para estruturar as páginas e organizar o conteúdo da aplicação.",
  },
  {
    name: "CSS",
    description:
      "Usado cotidianamente no trabalho para construir layouts, responsividade e a apresentação visual das interfaces.",
  },
];

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

  const selectAbout = (sectionId: AboutSectionId) => {
    if (sectionId === requestedAbout.current) return;

    requestedAbout.current = sectionId;
    setActiveAbout(sectionId);
    if (detailsPhase === "idle") setDetailsPhase("closing");
  };

  const handleAboutTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "clip-path") return;

    if (detailsPhase === "closing") {
      const panel = event.currentTarget.closest<HTMLElement>(".about-content");
      if (panel) panel.scrollTop = 0;
      setDisplayedAbout(requestedAbout.current);
      setDetailsPhase("opening");
    } else if (detailsPhase === "opening") {
      setDetailsPhase(requestedAbout.current === displayedAbout ? "idle" : "closing");
    }
  };

  const scrollToSection = (sectionId: string) => {
    const section = document.getElementById(sectionId);

    if (!section) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    section.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
    section.focus({ preventScroll: true });
  };

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
      <header className="home-header">
        <nav className="home-nav home-container" aria-label="Navegação principal">
          <button
            className="home-logo"
            type="button"
            onClick={() => scrollToSection("inicio")}
            aria-label="Ir para o início"
          >
            <span aria-hidden="true">&lt;</span>
            Henrique Volpini
            <span aria-hidden="true"> /&gt;</span>
          </button>

          <div className="home-nav-links">
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("inicio")}
            >
              Início
            </button>
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("about")}
            >
              Sobre
            </button>
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("stack")}
            >
              Stack
            </button>
            <button
              className="home-nav-link"
              type="button"
              onClick={() => scrollToSection("contato")}
            >
              Contato
            </button>
          </div>
        </nav>
      </header>

      <main className="home">
        <section
          className="home-hero home-container"
          id="inicio"
          aria-labelledby="home-title"
          tabIndex={-1}
        >
          <div className="hero-content">
            <span className="hero-eyebrow">Full-stack developer</span>

            <h1 className="hero-title" id="home-title">
              <span className="hero-title-first">Henrique</span>
              <span className="hero-title-last">Volpini</span>
            </h1>

            <p className="hero-description">
              Desenvolvendo aplicações web completas, da arquitetura à interface.
            </p>

            <p className="hero-technologies">
              Django <span aria-hidden="true">·</span> Django REST{" "}
              <span aria-hidden="true">·</span> TypeScript{" "}
              <span aria-hidden="true">·</span> Python
            </p>

          </div>

          <div className="hero-photo-wrapper">
            <div className="hero-photo-frame">
              <img
                className="hero-photo-image"
                src={profilePhoto}
                alt="Retrato de Henrique Volpini"
                width="800"
                height="800"
              />
            </div>
          </div>
        </section>

        <section
          className="home-about home-container"
          id="about"
          aria-labelledby="about-title"
          tabIndex={-1}
        >
          <div className="about-heading">
            <span className="about-index" aria-hidden="true">
              01
            </span>
            <span className="about-label" aria-hidden="true">
              About / {currentAbout.label}
            </span>
            <h2 id="about-title">Sobre mim</h2>

            <div className="about-tabs" role="tablist" aria-label="Tópicos sobre mim">
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

          <div
            className={`about-content${currentAbout.id === "work" ? " about-content--work" : ""}`}
            id="about-panel"
            role="tabpanel"
            aria-labelledby={`about-tab-${currentAbout.id}`}
            tabIndex={0}
          >
            <div className="about-reveal" data-phase={detailsPhase}>
              <div className="about-reveal-content" onTransitionEnd={handleAboutTransitionEnd}>
                {currentAbout.showBanestesLogo && (
                  <div className="about-company">
                    <img
                      src={banestesLogo}
                      alt="Banestes - Banco do Estado do Espírito Santo"
                      width="805"
                      height="823"
                      loading="lazy"
                    />
                    <span>Experiência atual</span>
                  </div>
                )}

                <div className="about-text">
                  {currentAbout.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </div>

                <div className="about-details-frame">
                  <dl className="about-details">
                    {currentAbout.details.map((detail) => (
                      <div key={detail.term}>
                        <dt>{detail.term}</dt>
                        <dd>{detail.description}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          className="home-stack home-container"
          id="stack"
          aria-labelledby="stack-title"
          tabIndex={-1}
        >
          <div className="section-heading">
            <span aria-hidden="true">02</span>
            <h2 id="stack-title">Stack</h2>
          </div>

          <ul className="stack-list">
            {technologies.map((technology, index) => (
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

        <section
          className="home-contact home-container"
          id="contato"
          aria-labelledby="contact-title"
          tabIndex={-1}
        >
          <div className="section-heading">
            <span aria-hidden="true">03</span>
            <h2 id="contact-title">Contato</h2>
          </div>

          <div className="contact-layout">
            <div className="contact-intro">
              <p className="contact-eyebrow">Vamos conversar</p>
              <p className="contact-title">Links diretos, sem formulário.</p>
              <p className="contact-description">
                Escolha o canal mais conveniente ou baixe a versão provisória do meu
                currículo.
              </p>
            </div>

            <ul className="contact-links">
              <li>
                <a
                  href="https://github.com/Henrique-Volpini"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="GitHub de Henrique Volpini (abre em nova aba)"
                >
                  <span>
                    <small>GitHub</small>
                    Henrique-Volpini
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <a
                  href="https://www.linkedin.com/in/henrique-volpini-gon%C3%A7alves-72aa55366/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn de Henrique Volpini Gonçalves (abre em nova aba)"
                >
                  <span>
                    <small>LinkedIn</small>
                    Henrique Volpini Gonçalves
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <a
                  href="https://wa.me/5527997899584"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Conversar com Henrique pelo WhatsApp no número mais 55 27 99789 9584 (abre em nova aba)"
                >
                  <span>
                    <small>WhatsApp</small>
                    +55 27 99789-9584
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <a
                  href="mailto:henriquev.comp@gmail.com"
                  aria-label="Enviar e-mail para Henrique em henriquev.comp@gmail.com"
                >
                  <span>
                    <small>E-mail</small>
                    henriquev.comp@gmail.com
                  </span>
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li>
                <a
                  href={`${import.meta.env.BASE_URL}curriculo-henrique-volpini.pdf`}
                  download="curriculo-henrique-volpini.pdf"
                >
                  <span>
                    <small>Currículo</small>
                    Baixar PDF
                  </span>
                  <span aria-hidden="true">↓</span>
                </a>
              </li>
            </ul>
          </div>
        </section>
      </main>
    </>
  );
}

export default Home;
