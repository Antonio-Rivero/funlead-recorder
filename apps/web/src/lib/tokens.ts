import { randomBytes } from "node:crypto";

// shareToken: 32-byte hex (64 chars) — the public key for /v/<token>.
export function newShareToken(): string {
  return randomBytes(32).toString("hex");
}

export function isValidShareToken(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
