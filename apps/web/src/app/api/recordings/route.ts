/**
 * GET  /api/recordings — lists the owner's recordings (FR-202, dashboard).
 * POST /api/recordings — registers a Recording row after the blob upload (FR-202).
 *
 * Both are gated to the authenticated owner (single-user). The server generates
 * the shareToken; the client never picks it.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/guard";
import { newShareToken } from "@/lib/tokens";
import { isAllowedRecordingBlobReference } from "@/lib/blob-url";

export const runtime = "nodejs";

export async function GET() {
  const denied = await requireOwner();
  if (denied) return denied;

  const recordings = await prisma.recording.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      shareToken: true,
      status: true,
      viewCount: true,
      durationSec: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ recordings });
}

export async function POST(request: NextRequest) {
  const denied = await requireOwner();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { blobUrl, blobPathname, title, mode, durationSec, sizeBytes, mimeType } = (body ??
    {}) as {
    blobUrl?: unknown;
    blobPathname?: unknown;
    title?: unknown;
    mode?: unknown;
    durationSec?: unknown;
    sizeBytes?: unknown;
    mimeType?: unknown;
  };

  if (
    typeof blobUrl !== "string" ||
    !blobUrl ||
    typeof blobPathname !== "string" ||
    !blobPathname
  ) {
    return NextResponse.json({ error: "Missing blobUrl or blobPathname" }, { status: 400 });
  }
  if (!isAllowedRecordingBlobReference({ blobUrl, blobPathname })) {
    return NextResponse.json({ error: "Invalid blobUrl or blobPathname" }, { status: 400 });
  }

  try {
    const recording = await prisma.recording.create({
      data: {
        title: typeof title === "string" && title.trim() ? title : "Untitled recording",
        shareToken: newShareToken(),
        blobUrl,
        blobPathname,
        mode: typeof mode === "string" && mode ? mode : "screen",
        durationSec: typeof durationSec === "number" ? durationSec : 0,
        sizeBytes: typeof sizeBytes === "number" ? sizeBytes : 0,
        mimeType: mimeType === "video/mp4" ? "video/mp4" : "video/webm",
        status: "ready",
      },
      select: { id: true, shareToken: true },
    });
    return NextResponse.json(recording);
  } catch {
    return NextResponse.json({ error: "Failed to register recording" }, { status: 500 });
  }
}
