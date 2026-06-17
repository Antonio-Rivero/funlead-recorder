/**
 * POST /api/recordings/[token]/cta-click — public CTA-click beacon (FR-205).
 *
 * Rate-limited per IP. Atomic increment of Recording.ctaClicks by shareToken,
 * only while the link isn't disabled. Responds 204 fast: it never blocks the
 * viewer's navigation.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidShareToken } from "@/lib/tokens";
import { rateLimit, rateLimitResponse, ipKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rl = rateLimit({ key: `recordings-cta-click:${ipKey(req)}`, max: 120, windowSec: 60 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const { token } = await params;
  if (!isValidShareToken(token)) {
    // Malformed token: silent no-op (must not break navigation).
    return new NextResponse(null, { status: 204 });
  }

  await prisma.recording.updateMany({
    where: { shareToken: token, disabledAt: null },
    data: { ctaClicks: { increment: 1 } },
  });

  return new NextResponse(null, { status: 204 });
}
