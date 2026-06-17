/**
 * Retention (drop-off) curve in pure SVG — no charting dependency, SSR-friendly,
 * mobile-safe. Uses only existing CSS variables. Native <title> tooltips (no JS).
 */
function formatTimecode(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

interface RetentionPoint {
  sec: number;
  ratio: number;
}

interface RetentionChartProps {
  points: RetentionPoint[];
  durationSec: number;
}

const W = 600; // viewBox; the SVG scales to the container width
const H = 180;
const PAD_L = 40;
const PAD_B = 22;
const PAD_T = 12;
const PAD_R = 10;

export default function RetentionChart({ points, durationSec }: RetentionChartProps) {
  const first = points[0];
  const lastPoint = points[points.length - 1];
  if (points.length < 2 || durationSec <= 0 || !first || !lastPoint) return null;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const x = (sec: number) => PAD_L + (sec / durationSec) * plotW;
  const y = (ratio: number) => PAD_T + (1 - ratio) * plotH;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.sec).toFixed(1)} ${y(p.ratio).toFixed(1)}`)
    .join(" ");
  const areaPath = `${linePath} L ${x(lastPoint.sec).toFixed(1)} ${y(0).toFixed(1)} L ${x(
    first.sec,
  ).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const finalRatio = lastPoint.ratio;

  return (
    <div>
      {/* Uniform scaling avoids deforming the line/points/text on mobile. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Retention curve: ${Math.round(finalRatio * 100)}% reach the end`}
      >
        {/* Horizontal gridlines 0/50/100% */}
        {[0, 0.5, 1].map((r) => (
          <g key={r}>
            <line
              x1={PAD_L}
              y1={y(r)}
              x2={W - PAD_R}
              y2={y(r)}
              stroke="var(--border)"
              strokeWidth={1}
              strokeDasharray={r === 0 ? undefined : "3 4"}
            />
            <text x={PAD_L - 8} y={y(r) + 4} fontSize={11} fill="var(--muted)" textAnchor="end">
              {Math.round(r * 100)}%
            </text>
          </g>
        ))}

        {/* Area + retention line (inherited primary color) */}
        <path d={areaPath} fill="var(--primary)" fillOpacity={0.1} />
        <path
          d={linePath}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Points with native tooltip */}
        {points.map((p) => (
          <circle key={p.sec} cx={x(p.sec)} cy={y(p.ratio)} r={2.5} fill="var(--primary)">
            <title>{`${formatTimecode(p.sec)} · ${Math.round(p.ratio * 100)}% still watching`}</title>
          </circle>
        ))}

        {/* Highlighted final point (how many reach the end). */}
        <circle cx={x(lastPoint.sec)} cy={y(lastPoint.ratio)} r={5} fill="var(--card)" />
        <circle cx={x(lastPoint.sec)} cy={y(lastPoint.ratio)} r={3.5} fill="var(--primary)">
          <title>{`${formatTimecode(lastPoint.sec)} · ${Math.round(
            lastPoint.ratio * 100,
          )}% still watching`}</title>
        </circle>

        {/* Time labels (start / middle / end) */}
        {[0, 0.5, 1].map((f) => (
          <text
            key={f}
            x={x(durationSec * f)}
            y={H - 5}
            fontSize={11}
            fill="var(--muted)"
            textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"}
          >
            {formatTimecode(Math.round(durationSec * f))}
          </text>
        ))}
      </svg>
      <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
        <span className="font-semibold tabular-nums text-[var(--foreground)]">
          {Math.round(finalRatio * 100)}%
        </span>{" "}
        of views reach the end.
      </p>
    </div>
  );
}
