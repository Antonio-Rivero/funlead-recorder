"use client";

import { useEffect, useRef, useState } from "react";
import { BODY_MAX, AUTHOR_MAX } from "@/lib/recordings/comments";

interface PublicComment {
  id: string;
  body: string;
  authorName: string;
  atSec: number | null;
  createdAt: string;
}

const VIEWER_KEY = "fl_viewer_id";

function readViewerId(): string | null {
  try {
    return window.localStorage.getItem(VIEWER_KEY);
  } catch {
    return null;
  }
}

function formatAtSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Seeks the single <video> on the page to the given second. There's one player on /v.
function seekTo(sec: number) {
  const video = document.querySelector("video");
  if (!video) return;
  video.currentTime = sec;
  video.scrollIntoView({ behavior: "smooth", block: "center" });
  void video.play().catch(() => {});
}

export default function PublicComments({ token }: { token: string }) {
  const [comments, setComments] = useState<PublicComment[]>([]);
  const [authorName, setAuthorName] = useState("");
  const [body, setBody] = useState("");
  const [markMoment, setMarkMoment] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void fetch(`/api/recordings/${token}/comments`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json?.comments) setComments(json.comments as PublicComment[]);
      })
      .catch(() => {});
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!authorName.trim() || !body.trim() || submitting) return;
    setError(null);
    setSubmitting(true);

    let atSec: number | null = null;
    if (markMoment) {
      const video = document.querySelector("video");
      if (video && Number.isFinite(video.currentTime)) {
        atSec = Math.floor(video.currentTime);
      }
    }

    try {
      const res = await fetch(`/api/recordings/${token}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authorName: authorName.trim(),
          body: body.trim(),
          atSec,
          viewerId: readViewerId(),
        }),
      });
      if (res.ok) {
        setSent(true);
        setBody("");
        setMarkMoment(false);
      } else {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(json?.error ?? "Could not send the comment.");
      }
    } catch {
      setError("Could not send the comment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-4 border-t border-[var(--border)] pt-5">
      <h2 className="text-sm font-semibold text-[var(--foreground)]">Comments</h2>

      {sent ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm text-[var(--foreground)]">
          Sent! The creator will review it before publishing.
          <button
            type="button"
            onClick={() => setSent(false)}
            className="ml-2 font-medium text-[var(--primary)] underline-offset-2 hover:underline"
          >
            Write another
          </button>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
        >
          <input
            type="text"
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            maxLength={AUTHOR_MAX}
            placeholder="Your name"
            aria-label="Your name"
            disabled={submitting}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)]/40 focus:outline-none disabled:opacity-50"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={BODY_MAX}
            placeholder="Write a comment…"
            aria-label="Comment"
            disabled={submitting}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)]/40 focus:outline-none disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
              <input
                type="checkbox"
                checked={markMoment}
                onChange={(e) => setMarkMoment(e.target.checked)}
                disabled={submitting}
                className="h-4 w-4 rounded border-[var(--border)]"
              />
              Mark the current moment of the video
            </label>
            <button
              type="submit"
              disabled={submitting || !authorName.trim() || !body.trim()}
              className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Sending…" : "Comment"}
            </button>
          </div>
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
        </form>
      )}

      {comments.length > 0 && (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li
              key={c.id}
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--foreground)]">{c.authorName}</span>
                {c.atSec !== null && (
                  <button
                    type="button"
                    onClick={() => seekTo(c.atSec as number)}
                    className="rounded-md bg-[var(--primary)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--primary)] transition hover:opacity-80"
                  >
                    {formatAtSec(c.atSec)}
                  </button>
                )}
                <span className="ml-auto text-xs text-[var(--muted)]">{formatDate(c.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-[var(--foreground)]">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
