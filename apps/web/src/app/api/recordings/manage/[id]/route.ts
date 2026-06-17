/**
 * PATCH /api/recordings/manage/[id] — owner edits the share link (FR-204/FR-207):
 *   title, description, CTA (label+url), end-card, expiry, password (set/clear),
 *   and revoke/reactivate (disabledAt). Owner-only (single-user).
 *
 * Kept under /manage/[id] instead of /api/recordings/[id] because the public
 * routes already own the [token] dynamic segment at that level (Next.js forbids
 * two slug names — [id] and [token] — at the same path).
 *
 * The passwordHash is never returned. Each field is applied only when present in
 * the body, validated by the pure parsers in lib/recordings/settings.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/guard";
import { parseExpiresAt } from "@/lib/recordings/expiry";
import {
  parseTitle,
  parseOptionalText,
  parseUrl,
  parsePassword,
  parseBoolean,
  DESCRIPTION_MAX,
  CTA_LABEL_MAX,
  END_CARD_TITLE_MAX,
} from "@/lib/recordings/settings";

export const runtime = "nodejs";

const BCRYPT_ROUNDS = 12;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireOwner();
  if (denied) return denied;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const {
    title,
    description,
    ctaLabel,
    ctaUrl,
    endCardTitle,
    endCardCtaLabel,
    endCardCtaUrl,
    expiresAt,
    password,
    disabled,
  } = (body ?? {}) as Record<string, unknown>;

  const data: Prisma.RecordingUpdateInput = {};

  if (title !== undefined) {
    const r = parseTitle(title);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.title = r.value;
  }
  if (description !== undefined) {
    const r = parseOptionalText(description, DESCRIPTION_MAX, "description");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.description = r.value;
  }
  if (ctaLabel !== undefined) {
    const r = parseOptionalText(ctaLabel, CTA_LABEL_MAX, "CTA label");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.ctaLabel = r.value;
  }
  if (ctaUrl !== undefined) {
    const r = parseUrl(ctaUrl, "CTA URL");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.ctaUrl = r.value;
  }
  if (endCardTitle !== undefined) {
    const r = parseOptionalText(endCardTitle, END_CARD_TITLE_MAX, "end-card title");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.endCardTitle = r.value;
  }
  if (endCardCtaLabel !== undefined) {
    const r = parseOptionalText(endCardCtaLabel, CTA_LABEL_MAX, "end-card label");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.endCardCtaLabel = r.value;
  }
  if (endCardCtaUrl !== undefined) {
    const r = parseUrl(endCardCtaUrl, "end-card URL");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.endCardCtaUrl = r.value;
  }
  if (expiresAt !== undefined) {
    const r = parseExpiresAt(expiresAt);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.expiresAt = r.value;
  }
  if (disabled !== undefined) {
    const r = parseBoolean(disabled, "disabled");
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.disabledAt = r.value ? new Date() : null;
  }
  if (password !== undefined) {
    const r = parsePassword(password);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
    data.passwordHash = r.action === "set" ? await hash(r.value, BCRYPT_ROUNDS) : null;
  }

  try {
    const updated = await prisma.recording.update({
      where: { id },
      data,
      select: {
        id: true,
        title: true,
        shareToken: true,
        description: true,
        ctaLabel: true,
        ctaUrl: true,
        endCardTitle: true,
        endCardCtaLabel: true,
        endCardCtaUrl: true,
        expiresAt: true,
        disabledAt: true,
      },
    });
    // Expose only whether a password is set, never the hash.
    return NextResponse.json({ ...updated, hasPassword: data.passwordHash !== undefined ? data.passwordHash !== null : undefined });
  } catch {
    return NextResponse.json({ error: "Recording not found" }, { status: 404 });
  }
}
