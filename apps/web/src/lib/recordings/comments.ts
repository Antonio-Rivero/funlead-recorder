// Pure logic for viewer comments on a recording (FR-206).
// Validation/normalization without Prisma or network — reusable by the endpoint.
//
// Comments are private by default: only the owner sees them in the dashboard,
// and the owner decides which to publish so they show on /v.

export const BODY_MAX = 2000;
export const AUTHOR_MAX = 80;

export type CommentInput = {
  body?: unknown;
  authorName?: unknown;
  atSec?: unknown;
};

export type CommentValidation =
  | { ok: true; body: string; authorName: string; atSec: number | null }
  | { ok: false; error: string };

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Normalizes atSec: integer >= 0 or null. Anything else (negative, NaN,
// non-numeric) → null, never throws (it's an optional field).
export function normalizeAtSec(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

// Validates a comment submission: body required (capped at BODY_MAX),
// authorName required (capped at AUTHOR_MAX), atSec optional.
export function validateComment(input: CommentInput): CommentValidation {
  const body = asString(input.body);
  if (!body) return { ok: false, error: "Comment cannot be empty" };

  const authorName = asString(input.authorName);
  if (!authorName) return { ok: false, error: "Name is required" };

  return {
    ok: true,
    body: body.slice(0, BODY_MAX),
    authorName: authorName.slice(0, AUTHOR_MAX),
    atSec: normalizeAtSec(input.atSec),
  };
}
