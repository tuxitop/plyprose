import { useRef, useState, useMemo, useCallback } from 'react';
import type { GamePly } from './InteractiveBoard';

interface EvaluationChartProps {
  evals: number[];
  currentPly: number;
  onSelectPly: (ply: number) => void;
  plies: GamePly[];
  liveEval?: string;
}

export function EvaluationChart({
  evals,
  currentPly,
  onSelectPly,
  plies,
  liveEval,
}: EvaluationChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredPly, setHoveredPly] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  const height = 96;
  const width = 400; // Reference viewBox coordinate space

  // Map centipawns to SVG Y coordinate (White is bottom, Black is top)
  const cpToY = useCallback(
    (cp: number) => {
      let winProb: number;
      if (Math.abs(cp) >= 9000) {
        // Absolute checkmate / forced mate: completely fill corresponding side
        winProb = cp > 0 ? 1 : 0;
      } else {
        const clampedCp = Math.max(-1500, Math.min(1500, cp));
        // Standard winning probability sigmoid
        winProb = 1 / (1 + Math.exp(-0.00368208 * clampedCp));
      }
      // winProb = 1 (White winning) -> Y = 0 (top, 100% white fill)
      // winProb = 0 (Black winning / White checkmated) -> Y = height (bottom, 0% white fill)
      return (1 - winProb) * height;
    },
    [height],
  );

  // Compute (x, y) coordinates for all points
  const points = useMemo(() => {
    if (!evals || evals.length === 0) return [];
    const totalPoints = evals.length;
    return evals.map((cp, idx) => {
      const x = (idx / Math.max(1, totalPoints - 1)) * width;
      const y = cpToY(cp);
      return { x, y, cp, ply: idx };
    });
  }, [evals, width, cpToY]);

  // Build smooth cubic bezier curve
  const { linePath, fillPath } = useMemo(() => {
    if (points.length === 0) return { linePath: '', fillPath: '' };
    if (points.length === 1) {
      const y = points[0].y;
      return {
        linePath: `M 0 ${y} L ${width} ${y}`,
        fillPath: `M 0 ${y} L ${width} ${y} L ${width} ${height} L 0 ${height} Z`,
      };
    }

    let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[Math.max(0, i - 1)];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[Math.min(points.length - 1, i + 2)];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = Math.max(0, Math.min(height, p1.y + (p2.y - p0.y) / 6));
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = Math.max(0, Math.min(height, p2.y - (p3.y - p1.y) / 6));

      d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }

    const fillD = `${d} L ${width} ${height} L 0 ${height} Z`;
    return { linePath: d, fillPath: fillD };
  }, [points, width, height]);

  // Active point for currentPly
  const activePoint = points[currentPly] || points[0];

  // Mouse interaction
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const relY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

      const ratio = relX / rect.width;
      const targetPly = Math.round(ratio * (points.length - 1));
      const clampedPly = Math.max(0, Math.min(points.length - 1, targetPly));

      setHoveredPly(clampedPly);
      setHoverPos({ x: (clampedPly / Math.max(1, points.length - 1)) * width, y: relY });
    },
    [points.length, width],
  );

  const handleMouseLeave = useCallback(() => {
    setHoveredPly(null);
    setHoverPos(null);
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = e.currentTarget;
      const rect = svg.getBoundingClientRect();
      const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratio = relX / rect.width;
      const targetPly = Math.round(ratio * (points.length - 1));
      const clampedPly = Math.max(0, Math.min(points.length - 1, targetPly));
      onSelectPly(clampedPly);
    },
    [points.length, onSelectPly],
  );

  // Tooltip data
  const tooltipData = useMemo(() => {
    const isHovered = hoveredPly !== null;
    const ply = isHovered ? hoveredPly : currentPly;
    if (ply < 0 || ply >= points.length) return null;
    const pt = points[ply];
    const plyObj = plies[ply];
    const cp = pt.cp;

    let evalStr: string;
    if (!isHovered && liveEval) {
      evalStr = liveEval;
    } else if (Math.abs(cp) >= 9000) {
      const rawMate = cp > 0 ? 10000 - cp : -(10000 + cp);
      const mate = rawMate === 0 ? (cp > 0 ? 1 : -1) : rawMate;
      evalStr = mate > 0 ? `+M${mate}` : `-M${Math.abs(mate)}`;
    } else {
      const pawn = (cp / 100).toFixed(1);
      evalStr = cp > 0 ? `+${pawn}` : pawn;
    }

    return {
      ply,
      moveNumber: plyObj?.moveNumber || Math.floor((ply - 1) / 2) + 1,
      color: plyObj?.color || (ply % 2 === 1 ? 'w' : 'b'),
      san: plyObj?.san || (ply === 0 ? 'Start' : ''),
      evalStr,
    };
  }, [hoveredPly, currentPly, points, plies, liveEval]);

  if (points.length === 0) return null;

  const activeX = activePoint ? activePoint.x : 0;
  const activeY = activePoint ? activePoint.y : height / 2;

  return (
    <div className="flex flex-col gap-1 p-2 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0 select-none">
      <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400 px-0.5">
        <span className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300">
          <span className="w-2 h-2 rounded-full bg-blue-500" />
          Game Evaluation Trajectory
        </span>
        {tooltipData && (
          <span className="font-mono text-xs">
            {tooltipData.ply === 0 ? (
              <span className="text-slate-500">Start (0.0)</span>
            ) : (
              <span>
                {tooltipData.moveNumber}.{tooltipData.color === 'b' ? '..' : ''}{' '}
                <strong className="text-slate-800 dark:text-slate-200">{tooltipData.san}</strong>{' '}
                <span
                  className={`font-bold ${
                    tooltipData.evalStr.startsWith('+')
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : tooltipData.evalStr.startsWith('-')
                        ? 'text-rose-600 dark:text-rose-400'
                        : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  ({tooltipData.evalStr})
                </span>
              </span>
            )}
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        className="w-full h-24 sm:h-28 md:h-32 rounded border border-slate-300 dark:border-slate-700 overflow-hidden relative cursor-crosshair bg-slate-800 dark:bg-slate-900 shadow-inner transition-[height] duration-200"
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full h-full block"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        >
          {/* Black territory: Background is dark (#1e293b) */}
          <rect x="0" y="0" width={width} height={height} fill="#1e293b" />

          {/* White territory: Soft light gray (#cbd5e1) instead of bright white */}
          <path d={fillPath} fill="#cbd5e1" />

          {/* Equal evaluation reference line (0.00) */}
          <line
            x1="0"
            y1={height / 2}
            x2={width}
            y2={height / 2}
            stroke="#94a3b8"
            strokeDasharray="3 3"
            strokeWidth="1"
            opacity="0.45"
          />

          {/* Smooth Evaluation Divider Curve */}
          <path d={linePath} fill="none" stroke="#64748b" strokeWidth="1.75" />

          {/* Hover indicator line */}
          {hoverPos && (
            <line
              x1={hoverPos.x}
              y1="0"
              x2={hoverPos.x}
              y2={height}
              stroke="#3b82f6"
              strokeDasharray="2 2"
              strokeWidth="1.2"
              opacity="0.8"
            />
          )}

          {/* Current game move marker */}
          <line x1={activeX} y1="0" x2={activeX} y2={height} stroke="#2563eb" strokeWidth="1.75" />
          <circle
            cx={activeX}
            cy={Math.max(3.5, Math.min(height - 3.5, activeY))}
            r="3.5"
            fill="#2563eb"
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        </svg>

        {/* Axis markers for White and Black */}
        <span className="absolute top-1 left-1.5 text-[9px] font-mono font-bold text-slate-300 pointer-events-none select-none">
          Black ▲
        </span>
        <span className="absolute bottom-1 left-1.5 text-[9px] font-mono font-bold text-slate-600 pointer-events-none select-none">
          White ▼
        </span>
      </div>
    </div>
  );
}
