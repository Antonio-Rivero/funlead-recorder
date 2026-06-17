"use client";

import { useEffect, useState } from "react";

// Owner moderation inbox (FR-206): lists ALL comments (public + private) and
// lets the owner publish/unpublish or delete each one.
interface OwnerComment {
  id: string;
  body: string;
  authorName: string;
  authorEmail: string | null;
  atSec: number | null;
  isPublic: boolean;
  createdAt: string;
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

export default function CommentsInbox({ recordingId }: { recordingId: string }) {
  const [comments, setComments] = useState<OwnerComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void fetch(`/api/recordings/comments?recordingId=${encodeURIComponent(recordingId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (active && json?.comments) setComments(json.comments as OwnerComment[]);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [recordingId]);

  async function toggle(id: string, next: boolean) {
    setBusyId(id);
    const prev = comments;
    setComments((cs) => cs.map((c) => (c.id === id ? { ...c, isPublic: next } : c)));
    try {
      const res = await fetch(`/api/recordings/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: next }),
      });
      if (!res.ok) setComments(prev);
    } catch {
      setComments(prev);
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this comment? This can't be undone.")) return;
    setBusyId(id);
    const prev = comments;
    setComments((cs) => cs.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/recordings/comments/${id}`, { method: "DELETE" });
      if (!res.ok) setComments(prev);
    } catch {
      setComments(prev);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
      <h2 className="text-sm font-semibold text-[var(--foreground)]">Comments</h2>
      <p className="mt-1 text-xs text-[var(--muted)]">
        Viewer comments are private until you publish them. Only published comments appear on the
        share page.
      </p>

      {loading ? (
        <p className="mt-3 text-sm text-[var(--muted)]">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted)]">No comments yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--border)]">
          {comments.map((c) => (
            <li key={c.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-[var(--foreground)]">{c.authorName}</span>
                {c.authorEmail && (
                  <span className="text-xs text-[var(--muted)]">{c.authorEmail}</span>
                )}
                {c.atSec !== null && (
                  <span className="rounded-md bg-[var(--card-hover)] px-1.5 py-0.5 text-xs text-[var(--muted)]">
                    {formatAtSec(c.atSec)}
                  </span>
                )}
                <span
                  className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${
                    c.isPublic
                      ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                      : "bg-[var(--card-hover)] text-[var(--muted)]"
                  }`}
                >
                  {c.isPublic ? "Public" : "Private"}
                </span>
                <span className="ml-auto text-xs text-[var(--muted)]">{formatDate(c.createdAt)}</span>
              </div>
              <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-[var(--foreground)]">
                {c.body}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggle(c.id, !c.isPublic)}
                  disabled={busyId === c.id}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--foreground)] transition hover:bg-[var(--card-hover)] disabled:opacity-50"
                >
                  {c.isPublic ? "Make private" : "Make public"}
                </button>
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  disabled={busyId === c.id}
                  className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--danger)]/40 hover:text-[var(--danger)] disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
