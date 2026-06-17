"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  DESCRIPTION_MAX,
  CTA_LABEL_MAX,
  END_CARD_TITLE_MAX,
} from "@/lib/recordings/settings";

// Owner form to edit the share link (FR-204/FR-207): title, description, CTA,
// end-card, expiry, password (set/clear), revoke/reactivate + copy the link.
// PATCHes /api/recordings/manage/[id]. The password value is never read back;
// `hasPassword` only reflects whether one is set.

export interface RecordingSettings {
  id: string;
  shareToken: string;
  title: string;
  description: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  endCardTitle: string | null;
  endCardCtaLabel: string | null;
  endCardCtaUrl: string | null;
  expiresAt: string | null; // ISO
  disabledAt: string | null; // ISO
  hasPassword: boolean;
}

// "2026-06-18T12:00:00.000Z" → "2026-06-18T13:00" in the browser's local zone,
// the format <input type="datetime-local"> expects.
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputClass =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none transition focus:border-[var(--primary)]/50";

export default function RecordingSettingsForm({
  recording,
  shareOrigin,
}: {
  recording: RecordingSettings;
  shareOrigin: string;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(recording.title);
  const [description, setDescription] = useState(recording.description ?? "");
  const [ctaLabel, setCtaLabel] = useState(recording.ctaLabel ?? "");
  const [ctaUrl, setCtaUrl] = useState(recording.ctaUrl ?? "");
  const [endCardTitle, setEndCardTitle] = useState(recording.endCardTitle ?? "");
  const [endCardCtaLabel, setEndCardCtaLabel] = useState(recording.endCardCtaLabel ?? "");
  const [endCardCtaUrl, setEndCardCtaUrl] = useState(recording.endCardCtaUrl ?? "");
  const [expiresAtLocal, setExpiresAtLocal] = useState(isoToLocalInput(recording.expiresAt));
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(recording.hasPassword);
  const [disabled, setDisabled] = useState(recording.disabledAt != null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl = `${shareOrigin}/v/${recording.shareToken}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — ignore.
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);

    const body: Record<string, unknown> = {
      title,
      description: description.trim() || null,
      ctaLabel: ctaLabel.trim() || null,
      ctaUrl: ctaUrl.trim() || null,
      endCardTitle: endCardTitle.trim() || null,
      endCardCtaLabel: endCardCtaLabel.trim() || null,
      endCardCtaUrl: endCardCtaUrl.trim() || null,
      expiresAt: expiresAtLocal ? new Date(expiresAtLocal).toISOString() : null,
      disabled,
    };
    // Only touch the password when the owner typed a new one (empty = leave as is).
    if (password.trim()) body.password = password.trim();

    try {
      const res = await fetch(`/api/recordings/manage/${recording.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Could not save the changes.");
      }
      if (password.trim()) {
        setHasPassword(true);
        setPassword("");
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the changes.");
    } finally {
      setSaving(false);
    }
  }

  async function clearPassword() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/recordings/manage/${recording.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: null }),
      });
      if (!res.ok) throw new Error("Could not remove the password.");
      setHasPassword(false);
      setPassword("");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5">
      <div>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Share link settings</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Control how viewers see this recording and who can open it.
        </p>
      </div>

      {/* Copy link */}
      <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-2.5">
        <input readOnly value={shareUrl} className="flex-1 truncate bg-transparent text-sm text-[var(--muted)] outline-none" />
        <button
          type="button"
          onClick={copyLink}
          className="shrink-0 rounded-md bg-[var(--primary)] px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
        >
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>

      <Field label="Title">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className={inputClass}
        />
      </Field>

      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={DESCRIPTION_MAX}
          placeholder="Shown under the title on the share page"
          className={inputClass}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="CTA button label">
          <input
            type="text"
            value={ctaLabel}
            onChange={(e) => setCtaLabel(e.target.value)}
            maxLength={CTA_LABEL_MAX}
            placeholder="Book a call"
            className={inputClass}
          />
        </Field>
        <Field label="CTA button URL">
          <input
            type="url"
            value={ctaUrl}
            onChange={(e) => setCtaUrl(e.target.value)}
            placeholder="https://funlead.app"
            className={inputClass}
          />
        </Field>
      </div>

      <fieldset className="space-y-4 rounded-lg border border-[var(--border)] p-4">
        <legend className="px-1 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
          End-card (overlay when the video ends)
        </legend>
        <Field label="End-card title">
          <input
            type="text"
            value={endCardTitle}
            onChange={(e) => setEndCardTitle(e.target.value)}
            maxLength={END_CARD_TITLE_MAX}
            placeholder="Thanks for watching"
            className={inputClass}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="End-card button label">
            <input
              type="text"
              value={endCardCtaLabel}
              onChange={(e) => setEndCardCtaLabel(e.target.value)}
              maxLength={CTA_LABEL_MAX}
              placeholder="Get started"
              className={inputClass}
            />
          </Field>
          <Field label="End-card button URL">
            <input
              type="url"
              value={endCardCtaUrl}
              onChange={(e) => setEndCardCtaUrl(e.target.value)}
              placeholder="https://funlead.app"
              className={inputClass}
            />
          </Field>
        </div>
        <p className="text-xs text-[var(--muted)]">
          If no end-card URL is set, the inline CTA above is used instead.
        </p>
      </fieldset>

      <Field label="Expires at (optional)">
        <input
          type="datetime-local"
          value={expiresAtLocal}
          onChange={(e) => setExpiresAtLocal(e.target.value)}
          className={inputClass}
        />
        <span className="text-xs text-[var(--muted)]">Leave empty for a link that never expires.</span>
      </Field>

      <fieldset className="space-y-3 rounded-lg border border-[var(--border)] p-4">
        <legend className="px-1 text-xs font-medium uppercase tracking-wider text-[var(--muted)]">
          Password
        </legend>
        <p className="text-xs text-[var(--muted)]">
          {hasPassword
            ? "This link is password-protected. Type a new password to change it, or remove it."
            : "No password. Type one to require it before the video plays."}
        </p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={hasPassword ? "New password" : "Set a password"}
          className={inputClass}
        />
        {hasPassword && (
          <button
            type="button"
            onClick={clearPassword}
            disabled={saving}
            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--muted)] transition hover:border-[var(--danger)]/40 hover:text-[var(--danger)] disabled:opacity-50"
          >
            Remove password
          </button>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm text-[var(--foreground)]">
        <input
          type="checkbox"
          checked={disabled}
          onChange={(e) => setDisabled(e.target.checked)}
          className="h-4 w-4 accent-[var(--primary)]"
        />
        Revoke this link (viewers see a “disabled” message)
      </label>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      {saved && !error && <p className="text-sm text-emerald-600">Saved.</p>}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-[var(--primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
