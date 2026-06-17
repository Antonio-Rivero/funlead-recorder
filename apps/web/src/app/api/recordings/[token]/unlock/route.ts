/**
 * POST /api/recordings/[token]/unlock — password unlock (FR-207).
 *
 * Validates the password against the Recording's passwordHash (bcrypt). On success
 * it sets the httpOnly cookie fl_pw_<recordingId> (~30 days) and returns
 * { ok: true }; otherwise 401. It NEVER returns the blobUrl or the hash: it only
 * confirms the unlock, and /v reveals the video when reloaded with the cookie set.
 *
 * Gate precedence: a disabled or expired link returns 410 before checking the
 * password.
 */
import { NextRequest, NextResponse } from "next/server";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitResponse, ipKey } from "@/lib/rate-limit";
import { isValidShareToken } from "@/lib/tokens";
import { pwCookieName } from "@/lib/recordings/access";
import { buildGateCookieValue } from "@/lib/recordings/gate-cookie";
import { isExpired } from "@/lib/recordings/expiry";

export const runtime = "nodejs";

const PW_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rl = rateLimit({ key: `recordings-unlock:${ipKey(req)}`, max: 10, windowSec: 60 });
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
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const recording = await prisma.recording.findUnique({
    where: { shareToken: token },
    select: { id: true, passwordHash: true, expiresAt: true, disabledAt: true },
  });
  if (!recording) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (recording.disabledAt != null) {
    return NextResponse.json({ error: "Link disabled" }, { status: 410 });
  }
  if (isExpired(recording.expiresAt)) {
    return NextResponse.json({ error: "Link expired" }, { status: 410 });
  }
  if (recording.passwordHash == null) {
    return NextResponse.json({ ok: true });
  }

  const valid = await compare(password, recording.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: "Wrong password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    pwCookieName(recording.id),
    buildGateCookieValue({ recordingId: recording.id, gate: "password", maxAgeSec: PW_COOKIE_MAX_AGE }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: PW_COOKIE_MAX_AGE,
    },
  );
  return res;
}
