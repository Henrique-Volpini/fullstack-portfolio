import { useRef } from "react";

const CONTACT_EMAIL = "henriquev.comp@gmail.com";

const privacyItems = [
  {
    term: "Dados que guardo",
    text: "Usuário, senha (guardada de forma protegida), e-mail se você informar e as mensagens do chat. No login com Google, recebo e-mail, nome e identificador da conta, nunca a senha. Nos logins também registro o IP e o navegador, só para barrar abusos. Uso tudo apenas para você entrar e conversar.",
  },
  {
    term: "Assistente e Google",
    text: "Sua mensagem ao assistente e as mais recentes dessa conversa (até 12 no total) são enviadas ao Google, pela API Gemini, para escolher qual informação do portfólio responder. Conversas diretas comigo não passam pelo Google. Evite escrever dados pessoais ao assistente.",
  },
  {
    term: "No seu navegador",
    text: "O tema escolhido fica no navegador até você limpar os dados do site. Depois do login, um código de acesso temporário vale só para a aba aberta e some quando você sai ou a fecha. Não uso cookies nem análise de visitas; o botão de login do Google carrega um script do Google, com a política dele.",
  },
  {
    term: "Prazo e exclusão",
    text: "Os dados ficam guardados enquanto a conta existir; não há apagamento automático. Para excluir sua conta e todas as mensagens, peça por e-mail.",
  },
];

// Botão do rodapé que abre o diálogo com o aviso de privacidade.
function PrivacyNotice() {
  const dialog = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);

  // Abre o diálogo como modal, se ainda não estiver aberto.
  const open = () => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  };

  // Fecha o diálogo.
  const close = () => dialog.current?.close();

  return (
    <>
      {/* Link do rodapé que abre o aviso. */}
      <button className="home-nav-link" type="button" aria-haspopup="dialog" onClick={open}>
        Privacidade
      </button>

      {/* Diálogo de privacidade; só fecha ao clicar no fundo se o clique também começou nele. */}
      <dialog
        className="privacy-dialog"
        ref={dialog}
        aria-labelledby="privacy-title"
        onPointerDown={(event) => {
          pressedBackdrop.current = event.target === event.currentTarget;
        }}
        onClick={(event) => {
          if (pressedBackdrop.current && event.target === event.currentTarget) close();
        }}
      >
        {/* Conteúdo do diálogo: título com botão de fechar e lista de itens. */}
        <div className="privacy-dialog-body">
          {/* Cabeçalho com o título e o botão de fechar. */}
          <div className="privacy-dialog-header">
            <h2 id="privacy-title">Privacidade</h2>
            <button
              className="privacy-dialog-close"
              type="button"
              aria-label="Fechar privacidade"
              onClick={close}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          {/* Lista de termos e explicações do aviso. */}
          <dl className="privacy-list">
            {privacyItems.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
            <div>
              <dt>Contato</dt>
              <dd>
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              </dd>
            </div>
          </dl>
        </div>
      </dialog>
    </>
  );
}

export default PrivacyNotice;
