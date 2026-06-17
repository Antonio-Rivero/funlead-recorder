import { describe, it, expect } from "vitest";
import {
  clampPosition,
  completionRatio,
  isCompleted,
  aggregateViews,
  buildRetentionCurve,
  type ViewRow,
} from "./analytics";

describe("clampPosition", () => {
  it("clamps to [0, duration]", () => {
    expect(clampPosition(50, 30)).toBe(30);
    expect(clampPosition(-5, 30)).toBe(0);
    expect(clampPosition(10, 30)).toBe(10);
  });
  it("with unknown duration returns floor of position", () => {
    expect(clampPosition(12.9, 0)).toBe(12);
  });
});

describe("completionRatio", () => {
  it("returns null with unknown duration", () => {
    expect(completionRatio(10, 0)).toBeNull();
  });
  it("caps at 1", () => {
    expect(completionRatio(40, 30)).toBe(1);
  });
});

describe("isCompleted", () => {
  it("true on ended regardless of position", () => {
    expect(isCompleted(0, 100, true)).toBe(true);
  });
  it("true at >= 90%", () => {
    expect(isCompleted(90, 100, false)).toBe(true);
    expect(isCompleted(89, 100, false)).toBe(false);
  });
  it("false with unknown duration unless ended", () => {
    expect(isCompleted(50, 0, false)).toBe(false);
  });
});

describe("aggregateViews", () => {
  const rows: ViewRow[] = [
    { viewerId: "a", maxPositionSec: 100, durationSecAtView: 100, completed: true, country: "ES", createdAt: new Date("2026-06-10") },
    { viewerId: "a", maxPositionSec: 50, durationSecAtView: 100, completed: false, country: null, createdAt: new Date("2026-06-09") },
    { viewerId: "b", maxPositionSec: 25, durationSecAtView: 100, completed: false, country: "US", createdAt: new Date("2026-06-08") },
  ];

  it("counts total and unique views", () => {
    const a = aggregateViews(rows);
    expect(a.totalViews).toBe(3);
    expect(a.uniqueViews).toBe(2);
  });

  it("completion rate = completed sessions / total", () => {
    expect(aggregateViews(rows).completionRate).toBeCloseTo(1 / 3);
  });

  it("per-viewer completion is the max across sessions", () => {
    const a = aggregateViews(rows);
    const viewerA = a.viewers.find((v) => v.viewerId === "a");
    expect(viewerA?.completionRatio).toBe(1);
    expect(viewerA?.views).toBe(2);
  });

  it("keeps first non-null country (caller orders by recency)", () => {
    const viewerA = aggregateViews(rows).viewers.find((v) => v.viewerId === "a");
    expect(viewerA?.country).toBe("ES");
  });

  it("handles empty input", () => {
    const a = aggregateViews([]);
    expect(a.totalViews).toBe(0);
    expect(a.avgCompletion).toBeNull();
    expect(a.completionRate).toBeNull();
  });
});

describe("buildRetentionCurve", () => {
  it("returns empty with no rows", () => {
    expect(buildRetentionCurve([], 100)).toEqual([]);
  });

  it("starts at 1.0 and decreases", () => {
    const rows = [{ maxPositionSec: 100 }, { maxPositionSec: 50 }, { maxPositionSec: 10 }];
    const curve = buildRetentionCurve(rows, 100, 10);
    expect(curve[0]?.ratio).toBe(1); // everyone reached second 0
    const last = curve[curve.length - 1];
    expect(last?.sec).toBe(100);
    expect(last?.ratio).toBeCloseTo(1 / 3); // only one reached the end
  });

  it("ends exactly at the duration", () => {
    const curve = buildRetentionCurve([{ maxPositionSec: 7 }], 7, 50);
    expect(curve[curve.length - 1]?.sec).toBe(7);
  });
});
