import { useRef } from "react";
import { texts } from "../../texts";

const CONTACT_EMAIL = "henriquev.comp@gmail.com";

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
        {texts.privacy.open}
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
            <h2 id="privacy-title">{texts.privacy.title}</h2>
            <button
              className="privacy-dialog-close"
              type="button"
              aria-label={texts.privacy.close}
              onClick={close}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          {/* Lista de termos e explicações do aviso. */}
          <dl className="privacy-list">
            {texts.privacy.items.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
            <div>
              <dt>{texts.privacy.contact}</dt>
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
