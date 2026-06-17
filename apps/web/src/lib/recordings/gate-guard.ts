// Shared access-gate guard for the public recording endpoints (reactions,
// comments, view). Resolves the same precedence as /v from the request cookies
// and returns a cut-off NextResponse, or null when access is granted.
import { NextRequest, NextResponse } from "next/server";
import { accessGate, pwCookieName, type AccessGate } from "./access";
import { verifyGateCookieValue } from "./gate-cookie";

export type GateRecording = {
  id: string;
  passwordHash: string | null;
  expiresAt: Date | null;
  disabledAt: Date | null;
};

export function resolveGate(recording: GateRecording, req: NextRequest): AccessGate {
  const passwordPassed = verifyGateCookieValue(req.cookies.get(pwCookieName(recording.id))?.value, {
    recordingId: recording.id,
    gate: "password",
  });
  return accessGate({
    disabledAt: recording.disabledAt,
    expiresAt: recording.expiresAt,
    passwordHash: recording.passwordHash,
    passwordPassed,
  });
}

// Returns a cut-off response when the viewer can't access the recording, or null.
export function gateOrNull(recording: GateRecording, req: NextRequest): NextResponse | null {
  const gate = resolveGate(recording, req);
  if (gate === "disabled") return NextResponse.json({ error: "Link disabled" }, { status: 410 });
  if (gate === "expired") return NextResponse.json({ error: "Link expired" }, { status: 410 });
  if (gate === "password") return NextResponse.json({ error: "No access" }, { status: 401 });
  return null;
}
