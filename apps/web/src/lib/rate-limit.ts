// Best-effort in-memory rate limiter for the public recording endpoints.
//
// Self-host, single-instance: an in-process fixed-window counter is enough to
// brake abuse without pulling in Redis or a DB table. On serverless (Vercel) the
// state is per-lambda, so it's a soft brake, not a hard guarantee — which is the
// right trade-off for a single-user self-hosted app.
import { NextResponse } from "next/server";

type Window = { count: number; resetAt: number };

const store = new Map<string, Window>();

export type RateLimitInput = {
  key: string;
  max: number;
  windowSec: number;
};

export type RateLimitResult =
  | { allowed: true; retryAfterSec?: never }
  | { allowed: false; retryAfterSec: number };

// Drops expired windows occasionally so the map can't grow unbounded.
function sweep(now: number): void {
  if (store.size < 5000) return;
  for (const [k, w] of store) {
    if (w.resetAt <= now) store.delete(k);
  }
}

export function rateLimit(input: RateLimitInput): RateLimitResult {
  const { key, max, windowSec } = input;
  if (!key || max <= 0 || windowSec <= 0) return { allowed: true };

  const now = Date.now();
  sweep(now);

  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { allowed: true };
  }

  if (existing.count < max) {
    existing.count += 1;
    return { allowed: true };
  }

  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
}

export function rateLimitResponse(
  result: { retryAfterSec: number },
  message = "Too many requests. Try again in a moment.",
): NextResponse {
  return NextResponse.json(
    { error: message, retryAfterSec: result.retryAfterSec },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSec) } },
  );
}

// Extracts the client IP from proxy headers. Defaults to "unknown".
export function ipKey(req: { headers: { get(name: string): string | null } }): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
