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
