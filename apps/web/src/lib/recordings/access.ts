// Access control for a recording link (FR-207: password + revoke + expiry).
//
// Pure logic, no DB — reused by /v, the /unlock endpoint, the view beacon, the
// reactions and comments endpoints. Gate precedence on /v is:
//
//   disabled → expired → password → video
//
// Every gate cuts before revealing the blobUrl: if accessGate returns anything
// other than "video", /v must not include the blob URL in the HTML.
import { isExpired } from "./expiry";

// Cookie that remembers a viewer already unlocked the password gate.
export function pwCookieName(recordingId: string): string {
  return `fl_pw_${recordingId}`;
}

export type AccessInputs = {
  disabledAt: Date | string | null | undefined;
  expiresAt: Date | string | null | undefined;
  passwordHash: string | null | undefined;
  // Viewer carries a valid fl_pw_<id> cookie.
  passwordPassed: boolean;
};

export type AccessGate = "disabled" | "expired" | "password" | "video";

function isDisabled(disabledAt: Date | string | null | undefined): boolean {
  return disabledAt != null;
}

// Decides what /v shows, honouring precedence (disabled > expired > password).
// Only "video" authorizes mounting the player with the blobUrl.
export function accessGate(input: AccessInputs, now: Date = new Date()): AccessGate {
  if (isDisabled(input.disabledAt)) return "disabled";
  if (isExpired(input.expiresAt, now)) return "expired";
  if (input.passwordHash != null && !input.passwordPassed) return "password";
  return "video";
}
