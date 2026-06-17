/**
 * GET /api/recordings/comments?recordingId=<id> — owner moderation inbox (FR-206).
 *
 * Lists ALL non-deleted comments (public and private) for one recording, most
 * recent first. Owner-only. Lives under the static /comments segment (not
 * /api/recordings/[id]/comments) because the public routes already own the
 * [token] dynamic segment at that level (Next.js forbids two slug names there).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/guard";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;

  const recordingId = req.nextUrl.searchParams.get("recordingId")?.trim();
  if (!recordingId) {
    return NextResponse.json({ error: "recordingId is required" }, { status: 400 });
  }

  const recording = await prisma.recording.findUnique({
    where: { id: recordingId },
    select: { id: true },
  });
  if (!recording) return NextResponse.json({ error: "Recording not found" }, { status: 404 });

  const comments = await prisma.recordingComment.findMany({
    where: { recordingId: recording.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      body: true,
      authorName: true,
      authorEmail: true,
      atSec: true,
      isPublic: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ comments });
}
