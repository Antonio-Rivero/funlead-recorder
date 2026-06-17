/**
 * /api/recordings/[token]/reactions  (public, no auth — the shareToken is the key)
 *
 *   POST → a viewer leaves an emoji reaction. Only palette emojis are accepted.
 *          Respects the same gate as /v (disabled/expired → 410, password → 401).
 *   GET  → aggregated count per emoji (every palette emoji, missing ones at 0).
 *
 * Opaque ids, no FK, rate-limited per IP.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitResponse, ipKey } from "@/lib/rate-limit";
import { isValidShareToken } from "@/lib/tokens";
import { gateOrNull } from "@/lib/recordings/gate-guard";
import { isReactionEmoji, parseReactionAtSec, tallyReactions } from "@/lib/recordings/reactions";

export const runtime = "nodejs";

const GATE_SELECT = {
  id: true,
  passwordHash: true,
  expiresAt: true,
  disabledAt: true,
} as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rl = rateLimit({ key: `recordings-reactions:${ipKey(req)}`, max: 10, windowSec: 60 });
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

  if (!isReactionEmoji(body.emoji)) {
    return NextResponse.json({ error: "Emoji not allowed" }, { status: 400 });
  }
  const emoji = body.emoji;
  const atSec = parseReactionAtSec(body.atSec);
  const viewerId =
    typeof body.viewerId === "string" && body.viewerId.trim()
      ? body.viewerId.trim().slice(0, 64)
      : null;

  const recording = await prisma.recording.findUnique({
    where: { shareToken: token },
    select: GATE_SELECT,
  });
  if (!recording) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blocked = gateOrNull(recording, req);
  if (blocked) return blocked;

  try {
    await prisma.recordingReaction.create({
      data: { recordingId: recording.id, emoji, viewerId, atSec },
    });
  } catch {
    return NextResponse.json({ error: "Failed to process" }, { status: 500 });
  }

  const grouped = await prisma.recordingReaction.groupBy({
    by: ["emoji"],
    where: { recordingId: recording.id },
    _count: { emoji: true },
  });
  return NextResponse.json({ ok: true, counts: tallyReactions(grouped) }, { status: 201 });
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

  const grouped = await prisma.recordingReaction.groupBy({
    by: ["emoji"],
    where: { recordingId: recording.id },
    _count: { emoji: true },
  });
  return NextResponse.json({ counts: tallyReactions(grouped) });
}
