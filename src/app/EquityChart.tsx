'use client';

import { useMemo, useState } from 'react';

export interface ChartPoint {
  time: number;
  equity: number;
  buyHold: number;
}

const W = 900;
const H = 260;
const PAD = { top: 16, right: 56, bottom: 26, left: 48 };

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function fmtEur(n: number): string {
  return `€${n.toFixed(n >= 100 ? 0 : 2)}`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/**
 * Two-series line chart: the bot against buying and holding the same amount on
 * day one. Crosshair and tooltip on hover; the numbers are also available as a
 * table below, so nothing here is gated behind colour or a pointing device.
 */
export default function EquityChart({ points }: { points: ChartPoint[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const geom = useMemo(() => {
    const values = points.flatMap((p) => [p.equity, p.buyHold]);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const padY = (hi - lo) * 0.12 || Math.max(hi * 0.05, 1);
    const yMin = Math.max(0, lo - padY);
    const yMax = hi + padY;
    const t0 = points[0].time;
    const t1 = points[points.length - 1].time;
    const span = t1 - t0 || 1;

    const x = (t: number) =>
      PAD.left + ((t - t0) / span) * (W - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - PAD.top - PAD.bottom);

    const path = (key: 'equity' | 'buyHold') =>
      points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.time).toFixed(1)},${y(p[key]).toFixed(1)}`)
        .join(' ');

    return { x, y, yMin, yMax, path, ticks: niceTicks(yMin, yMax) };
  }, [points]);

  const last = points[points.length - 1];
  const active = hoverIdx !== null ? points[hoverIdx] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const d = Math.abs(geom.x(p.time) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    setHoverIdx(best);
  }

  return (
    <div>
      <div className="legend">
        <span className="legend-item">
          <span className="legend-key" style={{ background: 'var(--series-1)' }} />
          The bot
        </span>
        <span className="legend-item">
          <span className="legend-key" style={{ background: 'var(--series-2)' }} />
          Buy and hold
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        role="img"
        aria-label="Bot equity compared with buying and holding bitcoin"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {geom.ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={geom.y(t)}
              y2={geom.y(t)}
              stroke="var(--gridline)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={geom.y(t) + 4}
              textAnchor="end"
              fontSize="11"
              fill="var(--text-muted)"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {fmtEur(t)}
            </text>
          </g>
        ))}

        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="var(--baseline)"
          strokeWidth="1"
        />
        <text
          x={PAD.left}
          y={H - PAD.bottom + 16}
          fontSize="11"
          fill="var(--text-muted)"
        >
          {fmtDate(points[0].time)}
        </text>
        <text
          x={W - PAD.right}
          y={H - PAD.bottom + 16}
          textAnchor="end"
          fontSize="11"
          fill="var(--text-muted)"
        >
          {fmtDate(last.time)}
        </text>

        <path
          d={geom.path('buyHold')}
          fill="none"
          stroke="var(--series-2)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={geom.path('equity')}
          fill="none"
          stroke="var(--series-1)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* End markers carry a 2px surface ring so they stay legible when the
            two lines cross near the right edge. */}
        <circle
          cx={geom.x(last.time)}
          cy={geom.y(last.buyHold)}
          r="4"
          fill="var(--series-2)"
          stroke="var(--surface-1)"
          strokeWidth="2"
        />
        <circle
          cx={geom.x(last.time)}
          cy={geom.y(last.equity)}
          r="4"
          fill="var(--series-1)"
          stroke="var(--surface-1)"
          strokeWidth="2"
        />
        <text
          x={geom.x(last.time) + 9}
          y={geom.y(last.equity) + 4}
          fontSize="12"
          fontWeight="600"
          fill="var(--text-primary)"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {fmtEur(last.equity)}
        </text>

        {active && (
          <g>
            <line
              x1={geom.x(active.time)}
              x2={geom.x(active.time)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--baseline)"
              strokeWidth="1"
            />
            <circle
              cx={geom.x(active.time)}
              cy={geom.y(active.buyHold)}
              r="4"
              fill="var(--series-2)"
              stroke="var(--surface-1)"
              strokeWidth="2"
            />
            <circle
              cx={geom.x(active.time)}
              cy={geom.y(active.equity)}
              r="4"
              fill="var(--series-1)"
              stroke="var(--surface-1)"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      <p
        className="tile-note"
        style={{ minHeight: 20, fontVariantNumeric: 'tabular-nums' }}
        aria-live="polite"
      >
        {active
          ? `${new Date(active.time).toLocaleDateString('en-GB', {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })} — bot ${fmtEur(active.equity)}, buy and hold ${fmtEur(active.buyHold)}`
          : 'Hover the chart to read a day.'}
      </p>
    </div>
  );
}
