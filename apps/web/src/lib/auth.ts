import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Single-user auth (FR-201). No registration, no NextAuth. One password lives in
// RECORDING_OWNER_PASSWORD. On login we set an httpOnly cookie whose value is an
// HMAC signature (keyed by RECORDING_GATE_COOKIE_SECRET) over a fixed payload +
// issued-at timestamp, so it cannot be forged without the secret and expires.

export const OWNER_COOKIE = "fl_recorder_owner";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const PAYLOAD = "owner";

function requireSecret(): string {
  const secret = process.env.RECORDING_GATE_COOKIE_SECRET;
  if (!secret) throw new Error("RECORDING_GATE_COOKIE_SECRET is not set");
  return secret;
}

function sign(value: string): string {
  return createHmac("sha256", requireSecret()).update(value).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Cookie value shape: "<issuedAtMs>.<hmac(payload + '.' + issuedAtMs)>".
export function createSessionToken(now = Date.now()): string {
  const issuedAt = String(now);
  const sig = sign(`${PAYLOAD}.${issuedAt}`);
  return `${issuedAt}.${sig}`;
}

export function isValidSessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const issuedAt = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const issuedAtMs = Number(issuedAt);
  if (!Number.isFinite(issuedAtMs)) return false;
  if (now - issuedAtMs > SESSION_TTL_MS) return false;
  return safeEqual(sig, sign(`${PAYLOAD}.${issuedAt}`));
}

export function verifyPassword(input: string): boolean {
  const expected = process.env.RECORDING_OWNER_PASSWORD;
  if (!expected) return false;
  return safeEqual(input, expected);
}

export function ownerCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

// Reads the request cookie and returns whether the caller is the authenticated owner.
export async function isOwner(): Promise<boolean> {
  const store = await cookies();
  return isValidSessionToken(store.get(OWNER_COOKIE)?.value);
}

// Desktop app auth (Fase 2): the native recorder has no owner cookie, so it
// authenticates with a shared bearer token the user sets as RECORDING_DESKTOP_TOKEN
// in their self-hosted instance and pastes into the app. Disabled (always false)
// until that env var is set, so it adds no surface on instances that don't use it.
export function isValidDesktopToken(authorizationHeader: string | null | undefined): boolean {
  const expected = process.env.RECORDING_DESKTOP_TOKEN;
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  const token = match?.[1];
  if (!token) return false;
  return safeEqual(token, expected);
}
