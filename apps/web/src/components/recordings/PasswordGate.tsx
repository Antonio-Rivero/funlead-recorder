"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface PasswordGateProps {
  token: string;
  title: string;
}

function LockIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export default function PasswordGate({ token, title }: PasswordGateProps) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError("Enter the password");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/recordings/${token}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(res.status === 401 ? "Wrong password" : json?.error ?? "Could not unlock.");
        setSubmitting(false);
        return;
      }
      // The endpoint set the fl_pw_<id> cookie; reload so /v reveals the video.
      router.refresh();
    } catch {
      setError("Could not unlock. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="relative isolate overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--color-navy)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_30%_20%,#60a5fa55,transparent_55%),radial-gradient(circle_at_80%_80%,#1e3a5f,#152844)]"
      />
      <div className="flex min-h-[22rem] items-center justify-center p-5 sm:p-8">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-md rounded-2xl border border-white/15 bg-[var(--card)]/95 p-6 shadow-2xl shadow-black/40 backdrop-blur-md"
        >
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--card-hover)] text-[var(--primary)]">
            <LockIcon />
          </div>
          <h2 className="mt-4 text-lg font-semibold text-[var(--foreground)]">
            This video is protected
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">Enter the password to watch “{title}”.</p>

          <label className="mt-5 block">
            <span className="text-xs font-medium text-[var(--muted)]">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--primary)]/40 focus:outline-none"
            />
          </label>

          {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="mt-5 w-full rounded-lg bg-[var(--primary)] px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {submitting ? "Checking…" : "Watch video"}
          </button>
        </form>
      </div>
    </div>
  );
}
