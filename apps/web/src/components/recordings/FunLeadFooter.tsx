/**
 * Subtle FunLead footer on the public viewer — the covert promo (FR-204).
 * No video watermark, no intrusive banner: a tasteful signature with two links
 * (the open-source repo and funlead.app). Value first, brand as a signature.
 */
const REPO_URL = "https://github.com/antoriv123/funlead-recorder";
const FUNLEAD_URL = "https://funlead.app";

export default function FunLeadFooter() {
  return (
    <footer className="pt-3 text-center text-xs text-[var(--muted)]">
      <p>
        Recorded with{" "}
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-[var(--foreground)] underline-offset-2 hover:underline"
        >
          FunLead Recorder
        </a>
      </p>
      <p className="mt-1">
        <a
          href={FUNLEAD_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 transition hover:text-[var(--foreground)] hover:underline"
        >
          FunLead — AI CRM for creators
        </a>
      </p>
    </footer>
  );
}
