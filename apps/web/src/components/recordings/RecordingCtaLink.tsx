"use client";

/**
 * CTA link that fires a cta-click beacon without blocking navigation. Used in the
 * public /v/[token] view (server component) and the player end-card (client).
 * Being a client component, the server component never passes functions down
 * (avoids the RSC hydration crash).
 */
interface RecordingCtaLinkProps {
  token: string;
  label: string;
  url: string;
  className?: string;
}

export default function RecordingCtaLink({ token, label, url, className }: RecordingCtaLinkProps) {
  function fireBeacon() {
    const endpoint = `/api/recordings/${encodeURIComponent(token)}/cta-click`;
    try {
      if (typeof navigator !== "undefined" && navigator.sendBeacon) {
        navigator.sendBeacon(endpoint);
        return;
      }
    } catch {
      // falls through to the fetch fallback
    }
    try {
      void fetch(endpoint, { method: "POST", keepalive: true }).catch(() => {});
    } catch {
      // tracking must never block navigation
    }
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={className}
      onClick={fireBeacon}
    >
      {label}
    </a>
  );
}
