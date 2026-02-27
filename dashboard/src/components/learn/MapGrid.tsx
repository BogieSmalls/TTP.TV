import { positionToGrid } from '../../lib/reviewQueue';

interface MapGridProps {
  position: number;
  prevPosition?: number;
  isDungeon: boolean;
}

export default function MapGrid({ position, prevPosition, isDungeon }: MapGridProps) {
  const cols = isDungeon ? 8 : 16;
  const rows = 8;
  const cellW = isDungeon ? 12 : 8;
  const cellH = 8;
  const pad = 16; // padding for labels
  const w = cols * cellW + pad;
  const h = rows * cellH + pad;

  const curr = positionToGrid(position, cols);
  const prev = prevPosition != null && prevPosition > 0
    ? positionToGrid(prevPosition, cols)
    : null;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      {/* Grid lines */}
      {Array.from({ length: cols + 1 }, (_, i) => (
        <line
          key={`v${i}`}
          x1={pad + i * cellW} y1={pad}
          x2={pad + i * cellW} y2={pad + rows * cellH}
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={0.5}
        />
      ))}
      {Array.from({ length: rows + 1 }, (_, i) => (
        <line
          key={`h${i}`}
          x1={pad} y1={pad + i * cellH}
          x2={pad + cols * cellW} y2={pad + i * cellH}
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={0.5}
        />
      ))}

      {/* Row labels (1-based) */}
      {Array.from({ length: rows }, (_, i) => (
        <text
          key={`rl${i}`}
          x={pad - 3} y={pad + i * cellH + cellH / 2 + 3}
          fill="rgba(255,255,255,0.25)"
          fontSize={7}
          textAnchor="end"
        >
          {i + 1}
        </text>
      ))}

      {/* Col labels (1-based) */}
      {Array.from({ length: cols }, (_, i) => (
        <text
          key={`cl${i}`}
          x={pad + i * cellW + cellW / 2} y={pad - 3}
          fill="rgba(255,255,255,0.25)"
          fontSize={7}
          textAnchor="middle"
        >
          {i + 1}
        </text>
      ))}

      {/* Previous position (dim) */}
      {prev && (
        <rect
          x={pad + prev.col * cellW + 1}
          y={pad + prev.row * cellH + 1}
          width={cellW - 2}
          height={cellH - 2}
          fill="rgba(255,255,255,0.15)"
          rx={1}
        />
      )}

      {/* Direction arrow */}
      {prev && (prev.row !== curr.row || prev.col !== curr.col) && (
        <line
          x1={pad + prev.col * cellW + cellW / 2}
          y1={pad + prev.row * cellH + cellH / 2}
          x2={pad + curr.col * cellW + cellW / 2}
          y2={pad + curr.row * cellH + cellH / 2}
          stroke="rgba(212,175,55,0.4)"
          strokeWidth={1}
          markerEnd="url(#arrow)"
        />
      )}

      {/* Current position (gold) */}
      <rect
        x={pad + curr.col * cellW + 0.5}
        y={pad + curr.row * cellH + 0.5}
        width={cellW - 1}
        height={cellH - 1}
        fill="#D4AF37"
        rx={1}
      />

      {/* Arrow marker definition */}
      <defs>
        <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="rgba(212,175,55,0.6)" />
        </marker>
      </defs>
    </svg>
  );
}
