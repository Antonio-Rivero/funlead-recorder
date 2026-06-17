/**
 * /api/recordings/[token]/comments  (public, no auth — the shareToken is the key)
 *
 *   POST → a viewer leaves a comment. Always created private (isPublic=false):
 *          only the owner sees it until they choose to publish. Respects the same
 *          gate as /v (disabled/expired → 410, password → 401): if you can't watch
 *          the video, you can't comment.
 *   GET  → lists the PUBLIC comments (isPublic=true, deletedAt=null) for /v.
 *          Never reveals private comments or sensitive author data.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitResponse, ipKey } from "@/lib/rate-limit";
import { isValidShareToken } from "@/lib/tokens";
import { gateOrNull } from "@/lib/recordings/gate-guard";
import { validateComment } from "@/lib/recordings/comments";

export const runtime = "nodejs";

function clean(value: string | null | undefined, max = 64): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.slice(0, max);
}

const GATE_SELECT = {
  id: true,
  passwordHash: true,
  expiresAt: true,
  disabledAt: true,
} as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rl = rateLimit({ key: `recordings-comments:${ipKey(req)}`, max: 10, windowSec: 60 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const { token } = await params;
  if (!isValidShareToken(token)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const body = (raw ?? {}) as Record<string, unknown>;

  const validation = validateComment({
    body: body.body,
    authorName: body.authorName,
    atSec: body.atSec,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const recording = await prisma.recording.findUnique({
    where: { shareToken: token },
    select: GATE_SELECT,
  });
  if (!recording) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blocked = gateOrNull(recording, req);
  if (blocked) return blocked;

  const viewerId = clean(typeof body.viewerId === "string" ? body.viewerId : null, 64);

  let created;
  try {
    created = await prisma.recordingComment.create({
      data: {
        recordingId: recording.id,
        body: validation.body,
        authorName: validation.authorName,
        viewerId,
        atSec: validation.atSec,
        isPublic: false,
      },
      select: { id: true },
    });
  } catch {
    return NextResponse.json({ error: "Failed to process" }, { status: 500 });
  }

  // Nothing private is revealed: confirm the submission and that it's pending review.
  return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isValidShareToken(token)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 400 });
  }

  const recording = await prisma.recording.findUnique({
    where: { shareToken: token },
    select: GATE_SELECT,
  });
  if (!recording) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blocked = gateOrNull(recording, req);
  if (blocked) return blocked;

  const comments = await prisma.recordingComment.findMany({
    where: { recordingId: recording.id, isPublic: true, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, body: true, authorName: true, atSec: true, createdAt: true },
  });

  return NextResponse.json({ comments });
}
