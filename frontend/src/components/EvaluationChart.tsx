import { useRef, useState, useMemo, useCallback } from 'react';
import type { GamePly } from './InteractiveBoard';
import { getClassificationBadge, type ClassificationType } from '../lib/badges';

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
  const [isDragging, setIsDragging] = useState(false);

  const height = 96;
  const width = 400; // Reference viewBox coordinate space
  const paddingY = 8;
  const innerHeight = height - paddingY * 2;

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
      // White winning (winProb = 1) -> y = paddingY (clearly visible curve, not clipped at border)
      // Black winning (winProb = 0) -> y = height - paddingY (clearly visible curve)
      return paddingY + (1 - winProb) * innerHeight;
    },
    [innerHeight, paddingY],
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

  const totalPoints = points.length;
  const totalMoves = Math.max(1, Math.floor((totalPoints - 1) / 2));
  const moveStep = totalMoves <= 25 ? 5 : totalMoves <= 60 ? 10 : 20;

  // Extract Critical Moments as points along the curve
  const criticalPoints = useMemo(() => {
    if (!plies || plies.length === 0 || points.length === 0) return [];
    const list: {
      ply: number;
      x: number;
      y: number;
      classification: string;
      badgeType: ClassificationType;
      color: string;
      symbol: string;
      label: string;
      san: string;
    }[] = [];

    for (let i = 0; i < points.length; i++) {
      const plyObj = plies[i];
      const cm = plyObj?.criticalMoment;
      if (!cm) continue;
      const badge = getClassificationBadge(cm.classification);
      if (!badge) continue;

      let color = '#f59e0b';
      switch (badge.type) {
        case 'blunder':
          color = '#ef4444';
          break;
        case 'mistake':
          color = '#f97316';
          break;
        case 'inaccuracy':
          color = '#f59e0b';
          break;
        case 'miss':
          color = '#e11d48';
          break;
        case 'brilliant':
          color = '#06b6d4';
          break;
        case 'great':
          color = '#3b82f6';
          break;
        case 'best':
        case 'checkmate':
          color = '#10b981';
          break;
      }

      list.push({
        ply: i,
        x: points[i].x,
        y: points[i].y,
        classification: cm.classification,
        badgeType: badge.type,
        color,
        symbol: badge.symbol,
        label: badge.label,
        san: plyObj.san,
      });
    }
    return list;
  }, [plies, points]);

  // Move ticks along X-axis to clearly display the game progression timeline
  const moveTicks = useMemo(() => {
    if (totalPoints <= 1) return [];
    const ticks: { ply: number; moveNum: number; x: number }[] = [];
    if (totalMoves > 10) {
      ticks.push({ ply: 1, moveNum: 1, x: (1 / Math.max(1, totalPoints - 1)) * width });
    }
    for (let m = moveStep; m < totalMoves; m += moveStep) {
      const ply = m * 2;
      if (ply < totalPoints - 1) {
        ticks.push({ ply, moveNum: m, x: (ply / Math.max(1, totalPoints - 1)) * width });
      }
    }
    const lastPly = totalPoints - 1;
    ticks.push({ ply: lastPly, moveNum: totalMoves, x: width });
    return ticks;
  }, [totalPoints, totalMoves, moveStep, width]);

  // Build smooth cubic bezier curve
  const { linePath, fillPath } = useMemo(() => {
    if (points.length === 0) return { linePath: '', fillPath: '' };
    if (points.length === 1) {
      const y = points[0].y;
      return {
        linePath: `M 0 ${y} L ${width} ${y}`,
        fillPath: `M 0 ${y} L ${width} ${height} L 0 ${height} Z`,
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

  // Scrubbing & seeking calculations
  const updatePlyFromClientX = useCallback(
    (clientX: number, target: SVGSVGElement) => {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0) return;
      const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const relY = Math.max(0, Math.min(rect.height, height / 2));
      const ratio = relX / rect.width;
      const targetPly = Math.round(ratio * (points.length - 1));
      const clampedPly = Math.max(0, Math.min(points.length - 1, targetPly));

      setHoveredPly(clampedPly);
      setHoverPos({ x: (clampedPly / Math.max(1, points.length - 1)) * width, y: relY });
      onSelectPly(clampedPly);
    },
    [points.length, width, height, onSelectPly],
  );

  const previewPlyFromClientX = useCallback(
    (clientX: number, target: SVGSVGElement) => {
      const rect = target.getBoundingClientRect();
      if (rect.width <= 0) return;
      const relX = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const relY = Math.max(0, Math.min(rect.height, height / 2));
      const ratio = relX / rect.width;
      const targetPly = Math.round(ratio * (points.length - 1));
      const clampedPly = Math.max(0, Math.min(points.length - 1, targetPly));

      setHoveredPly(clampedPly);
      setHoverPos({ x: (clampedPly / Math.max(1, points.length - 1)) * width, y: relY });
    },
    [points.length, width, height],
  );

  // Pointer event handlers (combines mouse and touch seamlessly)
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Safe fallback
      }
      setIsDragging(true);
      updatePlyFromClientX(e.clientX, e.currentTarget);
    },
    [updatePlyFromClientX],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (isDragging) {
        updatePlyFromClientX(e.clientX, e.currentTarget);
      } else {
        previewPlyFromClientX(e.clientX, e.currentTarget);
      }
    },
    [isDragging, updatePlyFromClientX, previewPlyFromClientX],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Safe fallback
    }
  }, []);

  const handlePointerCancel = useCallback(() => {
    setIsDragging(false);
    setHoveredPly(null);
    setHoverPos(null);
  }, []);

  const handlePointerLeave = useCallback(() => {
    if (!isDragging) {
      setHoveredPly(null);
      setHoverPos(null);
    }
  }, [isDragging]);

  // Touch event handlers for mobile gestures
  const handleTouchStart = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      if (e.touches.length > 0) {
        setIsDragging(true);
        updatePlyFromClientX(e.touches[0].clientX, e.currentTarget);
      }
    },
    [updatePlyFromClientX],
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      if (e.touches.length > 0) {
        updatePlyFromClientX(e.touches[0].clientX, e.currentTarget);
      }
    },
    [updatePlyFromClientX],
  );

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Tooltip data
  const tooltipData = useMemo(() => {
    const isHovered = hoveredPly !== null;
    const ply = isHovered ? hoveredPly : currentPly;
    if (ply < 0 || ply >= points.length) return null;
    const pt = points[ply];
    const plyObj = plies[ply];
    const cp = pt.cp;
    const cm = plyObj?.criticalMoment;
    const badge = cm ? getClassificationBadge(cm.classification) : null;

    let evalStr: string;
    if (!isHovered && liveEval) {
      evalStr = liveEval;
    } else if (Math.abs(cp) >= 9900) {
      const rawMate = cp > 0 ? 10000 - cp : -(10000 + cp);
      const mate = rawMate === 0 ? (cp > 0 ? 1 : -1) : rawMate;
      evalStr = mate > 0 ? `+M${mate}` : `-M${Math.abs(mate)}`;
    } else {
      const clampedCp = Math.max(-1000, Math.min(1000, cp));
      const pawn = (clampedCp / 100).toFixed(1);
      evalStr = clampedCp > 0 ? `+${pawn}` : pawn;
    }

    return {
      ply,
      moveNumber: plyObj?.moveNumber || Math.floor((ply - 1) / 2) + 1,
      color: plyObj?.color || (ply % 2 === 1 ? 'w' : 'b'),
      san: plyObj?.san || (ply === 0 ? 'Start' : ''),
      evalStr,
      criticalBadge: badge,
      bestMoveSan: cm?.best_move_san,
    };
  }, [hoveredPly, currentPly, points, plies, liveEval]);

  if (points.length === 0) return null;

  const activeX = activePoint ? activePoint.x : 0;
  const activeY = activePoint ? activePoint.y : height / 2;

  return (
    <div className="flex flex-col gap-1 p-2 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0 select-none">
      <div className="flex items-center justify-between text-[11px] font-medium text-slate-500 dark:text-slate-400 px-0.5 min-h-[22px]">
        <span className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-300 shrink-0">
          <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
          <span className="hidden sm:inline">Game Evaluation Trajectory</span>
          <span className="sm:hidden inline">Evaluation</span>
          <span className="font-normal text-slate-400 dark:text-slate-500 text-[10px] hidden sm:inline">
            ({totalMoves} moves · {totalPoints} plies)
          </span>
          <span className="font-normal text-slate-400 dark:text-slate-500 text-[10px] sm:hidden inline">
            ({totalMoves}m)
          </span>
        </span>

        {tooltipData && (
          <div className="flex items-center gap-1 font-mono text-xs overflow-hidden shrink-0">
            {tooltipData.ply === 0 ? (
              <span className="text-slate-500 text-[11px]">Start (0.0)</span>
            ) : (
              <span className="flex items-center gap-1 text-[11px]">
                <span>
                  {tooltipData.moveNumber}.{tooltipData.color === 'b' ? '..' : ''}{' '}
                  <strong className="text-slate-800 dark:text-slate-200">{tooltipData.san}</strong>
                </span>
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
                {tooltipData.criticalBadge && (
                  <span
                    className={`text-[9.5px] font-bold px-1.5 py-0.2 rounded text-white shrink-0 shadow-xs ${tooltipData.criticalBadge.bgClass}`}
                  >
                    {tooltipData.criticalBadge.symbol} {tooltipData.criticalBadge.label}
                  </span>
                )}
                <span className="text-[10px] text-slate-400 hidden sm:inline ml-0.5">
                  [{tooltipData.ply}/{totalPoints - 1}]
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      <div
        ref={containerRef}
        className="w-full h-[72px] sm:h-24 md:h-28 rounded border border-slate-300 dark:border-slate-700 overflow-hidden relative cursor-crosshair bg-slate-800 dark:bg-slate-900 shadow-inner transition-[height] duration-200 touch-none select-none"
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full h-full block touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onPointerLeave={handlePointerLeave}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
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

          {/* Timeline move grid vertical dashed lines & labels */}
          {moveTicks.map((t, i) => (
            <g key={i}>
              <line
                x1={t.x}
                y1="0"
                x2={t.x}
                y2={height}
                stroke="#64748b"
                strokeDasharray="2 3"
                strokeWidth="0.75"
                opacity="0.25"
              />
              <text
                x={Math.min(width - 12, Math.max(12, t.x))}
                y={height - 2.5}
                textAnchor="middle"
                fill="#94a3b8"
                fontSize="7.5"
                fontFamily="monospace"
                opacity="0.75"
              >
                m{t.moveNum}
              </text>
            </g>
          ))}

          {/* Smooth Evaluation Divider Curve */}
          <path d={linePath} fill="none" stroke="#475569" strokeWidth="2" />

          {/* Critical Move Markers along the Evaluation Curve */}
          {criticalPoints.map(cp => {
            const isSelected = cp.ply === currentPly || cp.ply === hoveredPly;
            const radius = isSelected ? 5.5 : 3.8;
            return (
              <g
                key={`cm-${cp.ply}`}
                className="cursor-pointer"
                onClick={e => {
                  e.stopPropagation();
                  onSelectPly(cp.ply);
                }}
              >
                <title>{`${cp.label} (${cp.symbol}) on move ${cp.san}`}</title>
                {/* Outer dark ring for contrast against light territory */}
                <circle cx={cp.x} cy={cp.y} r={radius + 1.2} fill="#0f172a" opacity="0.8" />
                {/* Colored critical badge circle */}
                <circle
                  cx={cp.x}
                  cy={cp.y}
                  r={radius}
                  fill={cp.color}
                  stroke="#ffffff"
                  strokeWidth={isSelected ? 2 : 1.2}
                />
                {/* When selected/active, add a subtle outer pulsing ring */}
                {isSelected && (
                  <circle
                    cx={cp.x}
                    cy={cp.y}
                    r={radius + 3}
                    fill="none"
                    stroke={cp.color}
                    strokeWidth="1.2"
                    opacity="0.6"
                    strokeDasharray="2 2"
                  />
                )}
              </g>
            );
          })}

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
            cy={Math.max(4, Math.min(height - 4, activeY))}
            r="3.5"
            fill="#2563eb"
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        </svg>

        {/* Axis markers for White and Black (positioned on right to prevent collision with early plies) */}
        <span className="absolute top-1 right-1.5 text-[8.5px] font-mono font-bold text-slate-400 pointer-events-none select-none opacity-60">
          Black ▲
        </span>
        <span className="absolute bottom-1 right-1.5 text-[8.5px] font-mono font-bold text-slate-600 pointer-events-none select-none opacity-60">
          White ▼
        </span>
      </div>
    </div>
  );
}
