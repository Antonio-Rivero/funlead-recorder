/**
 * /api/recordings/comments/[commentId] — owner moderation (FR-206). Owner-only.
 *
 *   PATCH  → { isPublic: boolean } publishes / unpublishes the comment on /v.
 *   DELETE → soft-delete (sets deletedAt; the row is kept).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/guard";
import { parseBoolean } from "@/lib/recordings/settings";

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> },
) {
  const denied = await requireOwner();
  if (denied) return denied;
  const { commentId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const r = parseBoolean((body as Record<string, unknown> | null)?.isPublic, "isPublic");
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });

  const result = await prisma.recordingComment.updateMany({
    where: { id: commentId, deletedAt: null },
    data: { isPublic: r.value },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, isPublic: r.value });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ commentId: string }> },
) {
  const denied = await requireOwner();
  if (denied) return denied;
  const { commentId } = await params;

  const result = await prisma.recordingComment.updateMany({
    where: { id: commentId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (result.count === 0) {
    return NextResponse.json({ error: "Comment not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
