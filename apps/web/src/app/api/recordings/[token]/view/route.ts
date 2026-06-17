/**
 * POST /api/recordings/[token]/view — public view beacon (FR-205).
 *
 * The client player calls it on play/heartbeat/ended. It upserts the session by
 * (recordingId, sessionId): one row per session, not per heartbeat. The recording
 * is resolved from its shareToken; nothing trusts the client body for identity.
 * Malformed token → 400; missing recording → 404 (so the client stops emitting).
 * Honours the same access gate as /v (disabled/expired → 410, password → 401).
 * country/city/ip/referrer/user-agent come from headers only when present.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidShareToken } from "@/lib/tokens";
import { clampPosition, isCompleted } from "@/lib/recordings/analytics";
import { rateLimit, rateLimitResponse, ipKey } from "@/lib/rate-limit";
import { isExpired } from "@/lib/recordings/expiry";
import { accessGate, pwCookieName } from "@/lib/recordings/access";
import { verifyGateCookieValue } from "@/lib/recordings/gate-cookie";
import { extractRequestGeo } from "@/lib/recordings/request-geo";

export const runtime = "nodejs";

type Body = {
  sessionId?: unknown;
  viewerId?: unknown;
  positionSec?: unknown;
  durationSec?: unknown;
  event?: unknown;
};

function clean(value: string | null | undefined, max = 500): string | null {
  const v = value?.trim();
  if (!v) return null;
  return v.slice(0, max);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const rl = rateLimit({ key: `recordings-view:${ipKey(req)}`, max: 120, windowSec: 60 });
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
  const body = (raw ?? {}) as Body;

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim().slice(0, 64) : "";
  const viewerId = typeof body.viewerId === "string" ? body.viewerId.trim().slice(0, 64) : "";
  const event = body.event === "start" || body.event === "heartbeat" || body.event === "ended"
    ? body.event
    : null;
  if (!sessionId || !viewerId || !event) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const positionSec = typeof body.positionSec === "number" && Number.isFinite(body.positionSec)
    ? body.positionSec
    : 0;
  const clientDuration = typeof body.durationSec === "number" && Number.isFinite(body.durationSec)
    ? body.durationSec
    : 0;

  const recording = await prisma.recording.findUnique({
    where: { shareToken: token },
    select: { id: true, durationSec: true, expiresAt: true, disabledAt: true, passwordHash: true },
  });
  if (!recording) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (recording.disabledAt != null) return new NextResponse(null, { status: 410 });
  if (isExpired(recording.expiresAt)) return new NextResponse(null, { status: 410 });

  const passwordPassed = verifyGateCookieValue(req.cookies.get(pwCookieName(recording.id))?.value, {
    recordingId: recording.id,
    gate: "password",
  });
  const gate = accessGate({
    disabledAt: recording.disabledAt,
    expiresAt: recording.expiresAt,
    passwordHash: recording.passwordHash,
    passwordPassed,
  });
  if (gate === "password") return new NextResponse(null, { status: 401 });

  // The real duration is on the Recording; the client only reports its <video>
  // reading (which can be 0 before metadata loads).
  const durationSec =
    recording.durationSec > 0
      ? recording.durationSec
      : clientDuration > 0
        ? Math.floor(clientDuration)
        : 0;

  const reportedPosition = clampPosition(positionSec, durationSec);
  const ended = event === "ended";

  const geo = extractRequestGeo(req.headers);
  const referrer = clean(req.headers.get("referer"), 2000);
  const userAgent = clean(req.headers.get("user-agent"), 1000);
  // UTMs come from the /v page URL the viewer landed on (carried by the referer),
  // not the beacon's own URL. Only captured when present.
  const refParams = (() => {
    try {
      return referrer ? new URL(referrer).searchParams : null;
    } catch {
      return null;
    }
  })();
  const utmSource = clean(refParams?.get("utm_source"), 200);
  const utmMedium = clean(refParams?.get("utm_medium"), 200);
  const utmCampaign = clean(refParams?.get("utm_campaign"), 200);

  let isNewSession = false;
  try {
    // maxPositionSec is monotonic: re-watching a stretch doesn't lower it. Prisma
    // upsert can't Math.max against the previous row, so read then raise in JS.
    const existing = await prisma.recordingView.findUnique({
      where: { recordingId_sessionId: { recordingId: recording.id, sessionId } },
      select: { maxPositionSec: true, completed: true },
    });
    isNewSession = existing === null;
    const maxPositionSec = Math.max(reportedPosition, existing?.maxPositionSec ?? 0);
    const completed =
      (existing?.completed ?? false) || isCompleted(maxPositionSec, durationSec, ended);

    await prisma.recordingView.upsert({
      where: { recordingId_sessionId: { recordingId: recording.id, sessionId } },
      create: {
        recordingId: recording.id,
        viewerId,
        sessionId,
        maxPositionSec,
        watchedSec: maxPositionSec,
        durationSecAtView: durationSec,
        completed,
        referrer,
        utmSource,
        utmMedium,
        utmCampaign,
        country: geo.country,
        city: geo.city,
        ipAddress: geo.ip,
        userAgent,
        lastHeartbeatAt: new Date(),
      },
      update: {
        maxPositionSec,
        watchedSec: maxPositionSec,
        durationSecAtView: durationSec,
        completed,
        lastHeartbeatAt: new Date(),
      },
    });
  } catch {
    // Fire-and-forget: a tracking failure must never break playback.
    return new NextResponse(null, { status: 204 });
  }

  // viewCount as a best-effort unique-views cache — only recomputed when a new
  // session is inserted (not on every heartbeat) to keep beacon load low.
  if (isNewSession) {
    try {
      const unique = await prisma.recordingView.findMany({
        where: { recordingId: recording.id },
        select: { viewerId: true },
        distinct: ["viewerId"],
      });
      await prisma.recording.update({
        where: { id: recording.id },
        data: { viewCount: unique.length },
      });
    } catch {
      // best-effort, doesn't break the beacon.
    }
  }

  return new NextResponse(null, { status: 204 });
}
