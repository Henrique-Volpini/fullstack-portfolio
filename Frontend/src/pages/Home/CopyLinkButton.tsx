import { useEffect, useRef, useState } from "react";

type CopyLinkButtonProps = {
  value: string;
  label: string;
};

function CopyLinkButton({ value, label }: CopyLinkButtonProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }

    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      className="copy-link"
      type="button"
      onClick={copy}
      aria-label={label}
      title={copied ? "Copiado!" : label}
      data-copied={copied}
    >
      <svg
        className="copy-link-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="11" height="11" rx="1.5" />
        <path d="M5 15V6a2 2 0 0 1 2-2h9" />
      </svg>
      <svg
        className="copy-link-check"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m5 12.5 4.5 4.5L19 7" />
      </svg>
      <span className="copy-link-status" role="status">
        {copied ? "Copiado" : ""}
      </span>
    </button>
  );
}

export default CopyLinkButton;
