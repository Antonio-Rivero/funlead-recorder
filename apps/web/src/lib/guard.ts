import { NextResponse } from "next/server";
import { isOwner } from "./auth";

// Owner guard for API routes. Returns a 401 response when the caller is not the
// authenticated owner, or null when access is granted.
export async function requireOwner(): Promise<NextResponse | null> {
  if (await isOwner()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
