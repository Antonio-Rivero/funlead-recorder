// Pure validators for the owner's "edit the share link" form (PATCH body).
// No Prisma, no network — so the PATCH endpoint stays thin and these are tested.

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 2000;
export const CTA_LABEL_MAX = 80;
export const URL_MAX = 2000;
export const END_CARD_TITLE_MAX = 120;
export const PASSWORD_MAX = 200;

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

function trimmedOrNull(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length === 0 ? null : t.slice(0, max);
}

// Title is required and non-empty when present in the body.
export function parseTitle(value: unknown): Ok<string> | Err {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: "Title is required" };
  }
  return { ok: true, value: value.trim().slice(0, TITLE_MAX) };
}

// Optional free text fields: null/empty → null, otherwise trimmed+capped.
export function parseOptionalText(value: unknown, max: number, label: string): Ok<string | null> | Err {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `Invalid ${label}` };
  return { ok: true, value: trimmedOrNull(value, max) };
}

// A CTA / end-card URL: null/empty clears it; otherwise must be a valid http(s) URL.
export function parseUrl(value: unknown, label: string): Ok<string | null> | Err {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `Invalid ${label}` };
  const t = value.trim();
  if (t.length === 0) return { ok: true, value: null };
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return { ok: false, error: `${label} must be a valid URL (https://…)` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `${label} must start with http:// or https://` };
  }
  return { ok: true, value: t.slice(0, URL_MAX) };
}

export type PasswordAction =
  | { ok: true; action: "clear" }
  | { ok: true; action: "set"; value: string }
  | Err;

// Password: null or empty string clears it; a non-empty string sets it.
// The endpoint hashes the value with bcrypt; this never hashes or stores.
export function parsePassword(value: unknown): PasswordAction {
  if (value === null) return { ok: true, action: "clear" };
  if (typeof value !== "string") return { ok: false, error: "Invalid password" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, action: "clear" };
  if (trimmed.length > PASSWORD_MAX) return { ok: false, error: "Password is too long" };
  return { ok: true, action: "set", value: trimmed };
}

export function parseBoolean(value: unknown, label: string): Ok<boolean> | Err {
  if (typeof value !== "boolean") return { ok: false, error: `Invalid ${label}` };
  return { ok: true, value };
}
