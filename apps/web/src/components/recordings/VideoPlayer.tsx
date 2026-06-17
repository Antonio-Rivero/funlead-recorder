"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RecordingCtaLink from "./RecordingCtaLink";
import { shouldShowEndCard } from "@/lib/recordings/cta";
import {
  REACTION_EMOJIS,
  emptyReactionCounts,
  type ReactionCounts,
  type ReactionEmoji,
} from "@/lib/recordings/reactions";

interface EndCard {
  title: string | null;
  label: string | null;
  url: string;
}

interface VideoPlayerProps {
  src: string;
  // shareToken for emitting analytics heartbeats and reactions. Without it, no tracking.
  token?: string;
  // Disables tracking (e.g. the owner watching their own video).
  trackingDisabled?: boolean;
  // Configurable overlay shown when the video ends. If null, no overlay.
  endCard?: EndCard | null;
  // Emoji reactions bar under the player. Requires token.
  reactionsEnabled?: boolean;
}

const HEARTBEAT_MS = 10_000;
const VIEWER_KEY = "fl_viewer_id";

function getOrCreateViewerId(): string | null {
  try {
    let id = window.localStorage.getItem(VIEWER_KEY);
    if (!id) {
      id = crypto.randomUUID();
      window.localStorage.setItem(VIEWER_KEY, id);
    }
    return id;
  } catch {
    // localStorage blocked → no tracking, the video still plays.
    return null;
  }
}

export default function VideoPlayer({
  src,
  token,
  trackingDisabled,
  endCard,
  reactionsEnabled,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasEndCard = Boolean(endCard);
  const [ended, setEnded] = useState(false);
  const showEndCard = shouldShowEndCard(hasEndCard, ended);

  // --- Reactions ---
  const [counts, setCounts] = useState<ReactionCounts>(emptyReactionCounts());
  const [reacting, setReacting] = useState(false);
  const reactionsActive = Boolean(reactionsEnabled && token);

  useEffect(() => {
    if (!reactionsActive || !token) return;
    let cancelled = false;
    void fetch(`/api/recordings/${encodeURIComponent(token)}/reactions`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.counts) setCounts(data.counts as ReactionCounts);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [reactionsActive, token]);

  const react = useCallback(
    (emoji: ReactionEmoji) => {
      if (!reactionsActive || !token || reacting) return;
      setReacting(true);
      setCounts((prev) => ({ ...prev, [emoji]: (prev[emoji] ?? 0) + 1 })); // optimistic
      const atSec = Math.floor(videoRef.current?.currentTime ?? 0);
      let viewerId: string | null = null;
      try {
        viewerId = window.localStorage.getItem(VIEWER_KEY);
      } catch {
        viewerId = null;
      }
      void fetch(`/api/recordings/${encodeURIComponent(token)}/reactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emoji, atSec, viewerId }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.counts) setCounts(data.counts as ReactionCounts); // reconcile with server
        })
        .catch(() => {})
        .finally(() => setReacting(false));
    },
    [reactionsActive, token, reacting],
  );

  // End-card overlay when the video ends. Independent of tracking (shown to owner too).
  useEffect(() => {
    if (!hasEndCard) return;
    const video = videoRef.current;
    if (!video) return;
    const onEnded = () => setEnded(true);
    const onPlay = () => setEnded(false);
    video.addEventListener("ended", onEnded);
    video.addEventListener("play", onPlay);
    return () => {
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("play", onPlay);
    };
  }, [hasEndCard, src]);

  function replay() {
    const video = videoRef.current;
    if (!video) return;
    setEnded(false);
    video.currentTime = 0;
    void video.play();
  }

  useEffect(() => {
    if (trackingDisabled || !token) return;
    const video = videoRef.current;
    if (!video) return;

    const viewerId = getOrCreateViewerId();
    if (!viewerId) return;
    const sessionId = (() => {
      try {
        return crypto.randomUUID();
      } catch {
        return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      }
    })();

    const endpoint = `/api/recordings/${encodeURIComponent(token)}/view`;
    let started = false;
    let stopped = false; // set if the endpoint returns 404 (video deleted)
    let interval: ReturnType<typeof setInterval> | null = null;

    const buildPayload = (event: "start" | "heartbeat" | "ended") => ({
      sessionId,
      viewerId,
      positionSec: Math.floor(video.currentTime || 0),
      durationSec: Number.isFinite(video.duration) ? Math.floor(video.duration) : 0,
      event,
    });

    const send = (event: "start" | "heartbeat" | "ended") => {
      if (stopped) return;
      void fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(event)),
        keepalive: true,
      })
        .then((res) => {
          if (res.status === 404) stopped = true; // stop emitting silently
        })
        .catch(() => {});
    };

    const sendBeacon = (event: "heartbeat" | "ended") => {
      if (stopped) return;
      try {
        const blob = new Blob([JSON.stringify(buildPayload(event))], { type: "application/json" });
        if (!navigator.sendBeacon(endpoint, blob)) send(event);
      } catch {
        send(event);
      }
    };

    const onPlay = () => {
      if (!started) {
        started = true;
        send("start"); // the view counts at play, not at load
      }
      if (interval === null) {
        interval = setInterval(() => send("heartbeat"), HEARTBEAT_MS);
      }
    };

    const stopInterval = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onPause = () => {
      stopInterval();
      if (started) sendBeacon("heartbeat");
    };

    const onEnded = () => {
      stopInterval();
      if (started) sendBeacon("ended");
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden" && started) sendBeacon("heartbeat");
    };

    const onPageHide = () => {
      stopInterval();
      if (started) sendBeacon("ended");
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      stopInterval();
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [token, trackingDisabled, src]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          className="w-full rounded-2xl border border-[var(--border)] bg-black shadow-lg shadow-black/20"
        />
        {showEndCard && endCard && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 rounded-2xl bg-black/75 px-6 text-center">
            {endCard.title && (
              <p className="max-w-md text-balance text-lg font-semibold leading-snug text-white sm:text-xl">
                {endCard.title}
              </p>
            )}
            <div className="flex flex-col items-center gap-3">
              {endCard.label &&
                (token ? (
                  <RecordingCtaLink
                    token={token}
                    label={endCard.label}
                    url={endCard.url}
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-[var(--primary)] px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
                  />
                ) : (
                  <a
                    href={endCard.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-[var(--primary)] px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90 active:scale-[0.98]"
                  >
                    {endCard.label}
                  </a>
                ))}
              <button
                type="button"
                onClick={replay}
                className="text-xs font-medium text-white/70 underline-offset-4 transition hover:text-white hover:underline"
              >
                Watch again
              </button>
            </div>
          </div>
        )}
      </div>

      {reactionsActive && (
        <div className="flex flex-wrap items-center gap-2">
          {REACTION_EMOJIS.map((emoji) => {
            const count = counts[emoji] ?? 0;
            return (
              <button
                key={emoji}
                type="button"
                onClick={() => react(emoji)}
                disabled={reacting}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)] px-3.5 text-base leading-none transition hover:bg-[var(--card-hover)] active:scale-95 disabled:opacity-60 disabled:active:scale-100"
              >
                <span aria-hidden="true">{emoji}</span>
                {count > 0 && (
                  <span className="text-xs font-semibold text-[var(--muted)]">{count}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
