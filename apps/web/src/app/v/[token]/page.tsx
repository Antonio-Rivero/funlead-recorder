/**
 * /v/<shareToken> — public view of a recording, NO owner auth (FR-204).
 * The shareToken (hex 64) is the key. Invalid token / deleted recording →
 * "Link not found".
 *
 * Access gate precedence: disabled → expired → password → video. Each gate cuts
 * before revealing the blobUrl: if the gate isn't "video", the HTML does not
 * include the blob URL.
 *
 * Analytics: the player emits heartbeats to /api/recordings/<token>/view. The
 * authenticated owner does NOT track their own video.
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { isOwner } from "@/lib/auth";
import { isValidShareToken } from "@/lib/tokens";
import { accessGate, pwCookieName } from "@/lib/recordings/access";
import { verifyGateCookieValue } from "@/lib/recordings/gate-cookie";
import { resolveEndCard } from "@/lib/recordings/cta";
import VideoPlayer from "@/components/recordings/VideoPlayer";
import PasswordGate from "@/components/recordings/PasswordGate";
import PublicComments from "@/components/recordings/PublicComments";
import RecordingCtaLink from "@/components/recordings/RecordingCtaLink";
import FunLeadFooter from "@/components/recordings/FunLeadFooter";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Recording",
  robots: { index: false },
};

function StateCard({
  icon,
  title,
  message,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
}) {
  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-10 text-[var(--foreground)]">
      <main className="mx-auto flex min-h-[60vh] w-full max-w-md items-center">
        <div className="w-full rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--card-hover)] text-[var(--muted)]">
            {icon}
          </div>
          <h1 className="mt-5 text-xl font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{message}</p>
        </div>
      </main>
    </div>
  );
}

function VideoOffIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
      <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function BanIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}

export default async function WatchRecordingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!isValidShareToken(token)) {
    return (
      <StateCard
        icon={<VideoOffIcon />}
        title="Link not found"
        message="This recording doesn't exist or has been deleted."
      />
    );
  }

  const recording = await prisma.recording.findUnique({
    where: { shareToken: token },
    select: {
      id: true,
      title: true,
      blobUrl: true,
      posterUrl: true,
      expiresAt: true,
      passwordHash: true,
      disabledAt: true,
      description: true,
      ctaLabel: true,
      ctaUrl: true,
      endCardTitle: true,
      endCardCtaLabel: true,
      endCardCtaUrl: true,
      transcript: true,
      transcriptStatus: true,
      transcriptPublic: true,
    },
  });
  if (!recording) {
    return (
      <StateCard
        icon={<VideoOffIcon />}
        title="Link not found"
        message="This recording doesn't exist or has been deleted."
      />
    );
  }

  // The authenticated owner doesn't generate views on their own video.
  const owner = await isOwner();

  const cookieStore = await cookies();
  const passwordPassed = verifyGateCookieValue(cookieStore.get(pwCookieName(recording.id))?.value, {
    recordingId: recording.id,
    gate: "password",
  });

  // Precedence: disabled → expired → password → video. Only "video" mounts the
  // player; the rest cut without leaking the blobUrl into the HTML.
  const gate = accessGate({
    disabledAt: recording.disabledAt,
    expiresAt: recording.expiresAt,
    passwordHash: recording.passwordHash,
    passwordPassed,
  });

  if (gate === "disabled") {
    return (
      <StateCard
        icon={<BanIcon />}
        title="This link has been disabled"
        message="Ask whoever shared it for a new one if you still need to watch it."
      />
    );
  }
  if (gate === "expired") {
    return (
      <StateCard
        icon={<ClockIcon />}
        title="This link has expired"
        message="Ask whoever shared it to generate a new one."
      />
    );
  }

  // CTA: only if both label and url exist. The URL was validated as http(s) when
  // saved; it's rendered as an attribute, never as HTML.
  const cta =
    recording.ctaLabel && recording.ctaUrl
      ? { label: recording.ctaLabel, url: recording.ctaUrl }
      : null;

  const endCard = resolveEndCard({
    endCardTitle: recording.endCardTitle,
    endCardCtaLabel: recording.endCardCtaLabel,
    endCardCtaUrl: recording.endCardCtaUrl,
    ctaLabel: recording.ctaLabel,
    ctaUrl: recording.ctaUrl,
  });

  return (
    <div className="min-h-screen bg-[var(--background)] px-4 py-8 text-[var(--foreground)]">
      <main className="mx-auto w-full max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold">{recording.title}</h1>
        {gate === "password" ? (
          // blobUrl does NOT travel in the HTML until unlocked.
          <PasswordGate token={token} title={recording.title} />
        ) : (
          <>
            <VideoPlayer
              src={recording.blobUrl}
              token={token}
              trackingDisabled={owner}
              endCard={endCard}
              reactionsEnabled
            />
            {recording.description && (
              <p className="whitespace-pre-line text-sm leading-relaxed text-[var(--muted)]">
                {recording.description}
              </p>
            )}
            {cta && (
              <div className="pt-1">
                <RecordingCtaLink
                  token={token}
                  label={cta.label}
                  url={cta.url}
                  className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.99] sm:w-auto"
                />
              </div>
            )}
            {recording.transcriptPublic &&
              recording.transcript &&
              recording.transcriptStatus === "ready" && (
                <details className="rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-[var(--foreground)]">
                    Transcript
                  </summary>
                  <div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-[var(--muted)]">
                    {recording.transcript}
                  </div>
                </details>
              )}
            <PublicComments token={token} />
          </>
        )}
        <FunLeadFooter />
      </main>
    </div>
  );
}
