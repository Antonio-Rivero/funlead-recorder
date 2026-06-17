/**
 * POST /api/recordings/upload — Vercel Blob client-upload handshake (FR-202).
 *
 * The browser uploads the video directly to Vercel Blob (bypassing the 4.5 MB
 * serverless body limit). This endpoint only mints the upload token and is
 * gated to the authenticated owner. Allowed types: video/webm and video/mp4.
 * The Recording row is created afterwards via POST /api/recordings.
 *
 * Max upload size is configurable via RECORDING_MAX_UPLOAD_MB (default 1024).
 */
import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { isOwner } from "@/lib/auth";

export const runtime = "nodejs";

function maxUploadBytes(): number {
  const mb = Number(process.env.RECORDING_MAX_UPLOAD_MB);
  const safeMb = Number.isFinite(mb) && mb > 0 ? mb : 1024;
  return safeMb * 1024 * 1024;
}

export async function POST(request: NextRequest) {
  // handleUpload also handles the blob "upload completed" callback (no owner
  // cookie on that server-to-server call), so authorize inside the token hook.
  try {
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => {
        if (!(await isOwner())) throw new Error("Unauthorized");
        return {
          allowedContentTypes: ["video/webm", "video/mp4"],
          addRandomSuffix: false,
          maximumSizeInBytes: maxUploadBytes(),
        };
      },
      onUploadCompleted: async () => {
        // No-op: the Recording row is created by the client via POST /api/recordings.
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 },
    );
  }
}
