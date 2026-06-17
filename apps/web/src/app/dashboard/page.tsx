import { redirect } from "next/navigation";
import { isOwner } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { LogoutButton } from "./LogoutButton";

// Reads the DB at request time, never at build.
export const dynamic = "force-dynamic";

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default async function DashboardPage() {
  if (!(await isOwner())) redirect("/login");

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

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-navy)]">
            Recordings
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {recordings.length} {recordings.length === 1 ? "recording" : "recordings"}
          </p>
        </div>
        <LogoutButton />
      </header>

      {recordings.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <h2 className="text-lg font-medium text-[var(--color-navy)]">No recordings yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-slate-500">
            Record from the desktop app and choose “Upload to my server”, or capture from your
            browser. Your videos will show up here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {recordings.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate font-medium text-[var(--color-navy)]">{r.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {new Date(r.createdAt).toLocaleDateString()} · {formatDuration(r.durationSec)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-4 text-sm text-slate-600">
                <span className="tabular-nums">{r.viewCount} views</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs capitalize">
                  {r.status}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
