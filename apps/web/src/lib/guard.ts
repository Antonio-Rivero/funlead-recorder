import { NextResponse } from "next/server";
import { isOwner, isValidDesktopToken } from "./auth";

// Owner guard for API routes. Returns a 401 response when the caller is not the
// authenticated owner, or null when access is granted.
export async function requireOwner(): Promise<NextResponse | null> {
  if (await isOwner()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

// Owner-or-desktop-token guard: the native recorder sends a Bearer
// RECORDING_DESKTOP_TOKEN instead of the owner cookie. Used by the upload + register
// endpoints so the desktop app can publish to a self-hosted instance.
export async function requireOwnerOrDesktop(request: Request): Promise<NextResponse | null> {
  if (await isOwner()) return null;
  if (isValidDesktopToken(request.headers.get("authorization"))) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
