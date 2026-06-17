// Signed gate cookie for the recording password gate (FR-207). The cookie value
// is an HMAC-signed payload (recordingId + gate + expiry), so it can't be forged
// without RECORDING_GATE_COOKIE_SECRET and it expires on its own.
import { createHmac, timingSafeEqual } from "node:crypto";

export type RecordingGateType = "password";

const VERSION = "v1";

function secret(): string | null {
  return process.env.RECORDING_GATE_COOKIE_SECRET || null;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string | null {
  const key = secret();
  if (!key) return null;
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

interface BuildInput {
  recordingId: string;
  gate: RecordingGateType;
  maxAgeSec: number;
  nowMs?: number;
}

interface VerifyInput {
  recordingId: string;
  gate: RecordingGateType;
  nowMs?: number;
}

export function buildGateCookieValue({
  recordingId,
  gate,
  maxAgeSec,
  nowMs = Date.now(),
}: BuildInput): string {
  const expiresAt = Math.floor(nowMs / 1000) + Math.max(1, Math.floor(maxAgeSec));
  const body = `${VERSION}.${base64url(JSON.stringify({ r: recordingId, g: gate, exp: expiresAt }))}`;
  const signature = sign(body);
  if (!signature) throw new Error("Missing RECORDING_GATE_COOKIE_SECRET for signed gate cookies");
  return `${body}.${signature}`;
}

export function verifyGateCookieValue(
  value: string | undefined | null,
  { recordingId, gate, nowMs = Date.now() }: VerifyInput,
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return false;
  const body = `${parts[0]}.${parts[1]}`;
  const signature = parts[2] ?? "";
  const expectedSignature = sign(body);
  if (!expectedSignature || !safeEqual(signature, expectedSignature)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      r?: unknown;
      g?: unknown;
      exp?: unknown;
    };
    if (parsed.r !== recordingId || parsed.g !== gate || typeof parsed.exp !== "number") return false;
    return parsed.exp >= Math.floor(nowMs / 1000);
  } catch {
    return false;
  }
}
