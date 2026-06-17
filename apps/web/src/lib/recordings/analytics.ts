// Pure analytics logic for recordings (FR-205). No Prisma, no network —
// testable in isolation.

export const COMPLETION_THRESHOLD = 0.9; // completed at >= 90% of the duration

// Clamps the position reported by the client to [0, durationSec].
export function clampPosition(positionSec: number, durationSec: number): number {
  if (!Number.isFinite(positionSec) || positionSec <= 0) return 0;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return Math.floor(positionSec);
  return Math.min(Math.floor(positionSec), Math.floor(durationSec));
}

// Session completion ratio: min(maxPositionSec, durationSec) / durationSec.
// If the duration is unknown (0), it can't be computed → null.
export function completionRatio(maxPositionSec: number, durationSec: number): number | null {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const watched = Math.min(Math.max(maxPositionSec, 0), durationSec);
  return watched / durationSec;
}

// Session completed? true if maxPositionSec >= 90% of the duration or the
// `ended` event arrived. With unknown duration, only `ended` counts.
export function isCompleted(maxPositionSec: number, durationSec: number, ended: boolean): boolean {
  if (ended) return true;
  const ratio = completionRatio(maxPositionSec, durationSec);
  if (ratio === null) return false;
  return ratio >= COMPLETION_THRESHOLD;
}

export type ViewRow = {
  viewerId: string;
  maxPositionSec: number;
  durationSecAtView: number;
  completed: boolean;
  country?: string | null;
  city?: string | null;
  ipAddress?: string | null;
  createdAt?: Date | null;
};

export type ViewerSummary = {
  viewerId: string;
  views: number;
  // % watched by this viewer: max completionRatio across their sessions (0-1), or null.
  completionRatio: number | null;
  country: string | null;
  city: string | null;
  // IP of the first non-null row of the viewer (owner dashboard only, GDPR).
  ipAddress: string | null;
  // Most recent view timestamp of the viewer, or null if unknown.
  lastViewedAt: Date | null;
};

export type RecordingAnalytics = {
  totalViews: number;
  uniqueViews: number;
  // Average completion over sessions with known duration (0-1), or null.
  avgCompletion: number | null;
  // Completion rate: completed sessions / total (0-1), or null if no sessions.
  completionRate: number | null;
  // Viewers with their view count, sorted by views desc.
  viewers: ViewerSummary[];
};

export type RetentionPoint = {
  // Video second.
  sec: number;
  // Fraction of sessions that reached at least this second (0-1).
  ratio: number;
};

// Per-second retention (drop-off) curve, ON-READ and with no extra writes.
//
// For each point `s` it computes what fraction of sessions reached at least that
// second (`maxPositionSec >= s`). It's the Loom-style drop-off curve: starts at
// 1.0 (everyone at s=0) and decreases. It doesn't capture re-watches or seeks,
// but it's honest, derived from already-stored data, and adds no write cost.
//
// Samples at most `maxPoints` seconds spread across the duration.
export function buildRetentionCurve(
  rows: Pick<ViewRow, "maxPositionSec">[],
  durationSec: number,
  maxPoints = 50,
): RetentionPoint[] {
  const total = rows.length;
  if (total === 0 || !Number.isFinite(durationSec) || durationSec <= 0) return [];

  const dur = Math.floor(durationSec);
  const step = Math.max(1, Math.ceil(dur / Math.max(1, maxPoints)));
  const points: RetentionPoint[] = [];
  for (let s = 0; s <= dur; s += step) {
    const reached = rows.reduce((n, r) => (r.maxPositionSec >= s ? n + 1 : n), 0);
    points.push({ sec: s, ratio: reached / total });
  }
  // Ensure an exact final point at the duration (if step didn't land on it).
  const last = points[points.length - 1];
  if (last && last.sec !== dur) {
    const reached = rows.reduce((n, r) => (r.maxPositionSec >= dur ? n + 1 : n), 0);
    points.push({ sec: dur, ratio: reached / total });
  }
  return points;
}

// Aggregates a list of sessions (RecordingView) into the dashboard metrics.
// Pure function: the caller passes the already-read rows.
export function aggregateViews(rows: ViewRow[]): RecordingAnalytics {
  const totalViews = rows.length;

  const byViewer = new Map<
    string,
    {
      views: number;
      completionRatio: number | null;
      country: string | null;
      city: string | null;
      ipAddress: string | null;
      lastViewedAt: Date | null;
    }
  >();
  let completionSum = 0;
  let completionCount = 0;
  let completedSessions = 0;

  for (const row of rows) {
    const entry =
      byViewer.get(row.viewerId) ??
      {
        views: 0,
        completionRatio: null,
        country: null,
        city: null,
        ipAddress: null,
        lastViewedAt: null,
      };
    byViewer.set(row.viewerId, entry);
    entry.views += 1;

    const ratio = completionRatio(row.maxPositionSec, row.durationSecAtView);
    if (ratio !== null) {
      // % per viewer = max reached across their sessions.
      entry.completionRatio =
        entry.completionRatio === null ? ratio : Math.max(entry.completionRatio, ratio);
      completionSum += ratio;
      completionCount += 1;
    }
    // First non-null country/city/IP: caller passes rows ordered by recency,
    // so the first one we see is the most recent known value.
    if (entry.country === null && row.country) entry.country = row.country;
    if (entry.city === null && row.city) entry.city = row.city;
    if (entry.ipAddress === null && row.ipAddress) entry.ipAddress = row.ipAddress;
    if (row.createdAt && (entry.lastViewedAt === null || row.createdAt > entry.lastViewedAt)) {
      entry.lastViewedAt = row.createdAt;
    }

    if (row.completed) completedSessions += 1;
  }

  const viewers: ViewerSummary[] = [...byViewer.entries()]
    .map(([viewerId, v]) => ({
      viewerId,
      views: v.views,
      completionRatio: v.completionRatio,
      country: v.country,
      city: v.city,
      ipAddress: v.ipAddress,
      lastViewedAt: v.lastViewedAt,
    }))
    .sort((a, b) => b.views - a.views);

  return {
    totalViews,
    uniqueViews: byViewer.size,
    avgCompletion: completionCount > 0 ? completionSum / completionCount : null,
    completionRate: totalViews > 0 ? completedSessions / totalViews : null,
    viewers,
  };
}
