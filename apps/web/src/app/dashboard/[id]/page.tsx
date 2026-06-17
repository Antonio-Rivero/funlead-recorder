import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { aggregateViews, buildRetentionCurve, type ViewRow } from "@/lib/recordings/analytics";
import RetentionChart from "@/components/recordings/RetentionChart";
import StatCountUp from "@/components/recordings/StatCountUp";

// Reads the DB at request time, never at build.
export const dynamic = "force-dynamic";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pct(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

function shortViewer(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export default async function RecordingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await isOwner())) redirect("/login");
  const { id } = await params;

  const recording = await prisma.recording.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      shareToken: true,
      durationSec: true,
      viewCount: true,
      ctaClicks: true,
      status: true,
      createdAt: true,
    },
  });
  if (!recording) notFound();

  // Ordered by recency so aggregateViews picks the most recent geo per viewer.
  const views = await prisma.recordingView.findMany({
    where: { recordingId: recording.id },
    orderBy: { createdAt: "desc" },
    select: {
      viewerId: true,
      maxPositionSec: true,
      durationSecAtView: true,
      completed: true,
      country: true,
      city: true,
      createdAt: true,
    },
  });

  const rows: ViewRow[] = views;
  const analytics = aggregateViews(rows);
  const retention = buildRetentionCurve(
    views.map((v) => ({ maxPositionSec: v.maxPositionSec })),
    recording.durationSec,
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8">
        <Link
          href="/dashboard"
          className="text-sm text-[var(--muted)] underline-offset-2 hover:underline"
        >
          ← Recordings
        </Link>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-[var(--color-navy)]">
          {recording.title}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {new Date(recording.createdAt).toLocaleDateString()} ·{" "}
          {formatDuration(recording.durationSec)} ·{" "}
          <a
            href={`/v/${recording.shareToken}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-navy)] underline-offset-2 hover:underline"
          >
            Open share link
          </a>
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Views", value: analytics.totalViews },
          { label: "Unique viewers", value: analytics.uniqueViews },
          { label: "CTA clicks", value: recording.ctaClicks },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-slate-200 bg-white p-4"
          >
            <p className="text-2xl font-semibold tabular-nums text-[var(--color-navy)]">
              <StatCountUp value={s.value} />
            </p>
            <p className="mt-0.5 text-xs text-slate-500">{s.label}</p>
          </div>
        ))}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-2xl font-semibold tabular-nums text-[var(--color-navy)]">
            {pct(analytics.completionRate)}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">Completed</p>
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-[var(--color-navy)]">Retention</h2>
        {retention.length >= 2 ? (
          <div className="mt-3">
            <RetentionChart points={retention} durationSec={recording.durationSec} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-500">
            Not enough views yet to draw the drop-off curve.
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-navy)]">Viewers</h2>
        {analytics.viewers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No views yet. Share the link to start collecting analytics.
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
            {analytics.viewers.map((v) => (
              <li
                key={v.viewerId}
                className="flex items-center justify-between gap-4 px-5 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-[var(--color-navy)]">
                    {shortViewer(v.viewerId)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {[v.city, v.country].filter(Boolean).join(", ") || "Unknown location"}
                    {v.lastViewedAt
                      ? ` · ${new Date(v.lastViewedAt).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-4 text-slate-600">
                  <span className="tabular-nums">
                    {v.views} {v.views === 1 ? "view" : "views"}
                  </span>
                  <span className="tabular-nums font-medium text-[var(--color-navy)]">
                    {pct(v.completionRatio)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
