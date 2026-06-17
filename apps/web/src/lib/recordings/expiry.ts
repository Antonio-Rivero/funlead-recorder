// Link expiry for recordings (FR-207). expiresAt null = never expires.
// Pure logic, no DB — reused by /v, the view beacon, and dashboard badges.

export function isExpired(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (expiresAt == null) return false;
  const at = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return false;
  return now.getTime() > at.getTime();
}

// Parses the owner-supplied expiresAt from a PATCH body: null clears it, an ISO
// string must be a valid future date. Anything else is rejected.
export function parseExpiresAt(
  value: unknown,
  now: Date = new Date(),
): { ok: true; value: Date | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: "Invalid expiry date" };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { ok: false, error: "Invalid expiry date" };
  if (at.getTime() <= now.getTime()) {
    return { ok: false, error: "Expiry date must be in the future" };
  }
  return { ok: true, value: at };
}
