import { ExternalLink, FileText, Github, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from './Badge';
import {
  platformBadgeVariant,
  platformLabel,
  resultBadgeVariant,
  resultLabel,
} from '../lib/badges';
import { formatTC, formatGameTimeLocal as formatGameTime } from '../lib/timeControl';
import type { GameRecord } from '../types';

interface GamesTableProps {
  games: GameRecord[];
  loading: boolean;
  activeJobId: string | null;
  activeGameKey?: string | null;
  activeJobProgress: number;
  activeJobMessage: string;
  onViewReport: (id: number) => void;
  onAnalyze: (game: GameRecord) => void;
  onDelete: (game: GameRecord) => void;
  onSyncToGitHub?: (game: GameRecord) => void;
  syncingGameId?: number | null;
}

function MiniEvalChart({ evals, movesCount }: { evals?: number[]; movesCount?: number }) {
  if (!evals || evals.length < 2) {
    return <span className="text-slate-300 dark:text-slate-600 font-mono text-[11px]">—</span>;
  }

  const width = 160;
  const height = 32;
  const n = evals.length;

  const points = evals.map((cp, idx) => {
    const clampedCp = Math.max(-1000, Math.min(1000, cp));
    const winProb = 1 / (1 + Math.exp(-0.00368208 * clampedCp));
    const x = (idx / (n - 1)) * width;
    const y = 2 + (1 - winProb) * (height - 4);
    return { x, y };
  });

  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  const fillD = `${d} L ${width} ${height} L 0 ${height} Z`;

  return (
    <div
      className="inline-block w-28 sm:w-36 md:w-48 lg:w-56 max-w-full h-7 sm:h-8 md:h-9 rounded border border-slate-200 dark:border-slate-700/80 overflow-hidden bg-slate-800 align-middle shadow-xs transition-all"
      title={`Evaluation Trajectory (${movesCount ? `${movesCount} moves / ` : ''}${evals.length} plies)`}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full h-full block"
      >
        <rect x="0" y="0" width={width} height={height} fill="#1e293b" />
        <path d={fillD} fill="#cbd5e1" />
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#94a3b8"
          strokeDasharray="2 2"
          strokeWidth="0.75"
          opacity="0.5"
        />
        <path d={d} fill="none" stroke="#64748b" strokeWidth="1" />
      </svg>
    </div>
  );
}

export function GamesTable({
  games,
  loading,
  activeJobId,
  activeGameKey,
  activeJobProgress,
  activeJobMessage,
  onViewReport,
  onAnalyze,
  onDelete,
  onSyncToGitHub,
  syncingGameId,
}: GamesTableProps) {
  if (loading) {
    return (
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-12 text-center text-slate-400 dark:text-slate-500 text-sm">
        <svg
          className="animate-spin h-5 w-5 mx-auto mb-2 text-slate-400 dark:text-slate-500"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
        Loading games…
      </div>
    );
  }

  if (games.length === 0) {
    return (
      <div className="border border-dashed border-slate-200 dark:border-slate-800 rounded-lg p-12 text-center">
        <span className="text-3xl block mb-2" aria-hidden="true">
          ♟
        </span>
        <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No games found</p>
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
          Import a PGN or sync games from your connected accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto bg-white dark:bg-slate-900">
      <table className="w-full text-left text-xs">
        <thead className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold">
          <tr>
            <th className="py-2.5 px-3 w-8">#</th>
            <th className="py-2.5 px-3 w-60 sm:w-64 md:w-72">Platform & Speed</th>
            <th className="py-2.5 px-3 w-10 text-center">Side</th>
            <th className="py-2.5 px-3">Players</th>
            <th className="py-2.5 px-3 w-20">Result</th>
            <th className="py-2.5 px-3 w-32 sm:w-44 md:w-56 text-center">Eval</th>
            <th className="py-2.5 px-3 w-32 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
          {games.map((g, idx) => {
            const isAnalyzed = g.analyzed ?? Boolean(g.report_md);
            const gameKey = `${isAnalyzed ? 'a' : 'p'}-${g.id}`;
            const isThisGameAnalyzing = Boolean(activeJobId) && activeGameKey === gameKey;
            const isAnyAnalyzing = Boolean(activeJobId);
            const white = g.white_player || g.white || 'White';
            const black = g.black_player || g.black || 'Black';
            const isWhite = g.side === 'white';
            const isBlack = g.side === 'black';
            const movesCount =
              g.moves_count ||
              (g.total_plies
                ? Math.ceil(g.total_plies / 2)
                : g.ply_evals && g.ply_evals.length > 1
                  ? Math.floor(g.ply_evals.length / 2)
                  : 0);

            return (
              <tr
                key={gameKey}
                className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors"
              >
                <td className="py-3 px-3 text-slate-400 dark:text-slate-500 font-mono">
                  {idx + 1}
                </td>

                <td className="py-3 px-3 w-60 sm:w-64 md:w-72">
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-1.5 whitespace-nowrap">
                      <Badge
                        variant={platformBadgeVariant(g.platform)}
                        className="font-mono text-[10px] uppercase shrink-0"
                      >
                        {platformLabel(g.platform)}
                      </Badge>
                      <span className="font-semibold text-slate-800 dark:text-slate-200 shrink-0">
                        {g.speed_icon} {g.speed_label}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400 font-mono shrink-0">
                        {formatTC(g.time_control)}
                      </span>
                      {!isAnalyzed ? (
                        <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800 shrink-0">
                          Pending
                        </span>
                      ) : g.github_sync_status === 'synced' ? (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 shrink-0"
                          title={`Synced to GitHub:\n${g.github_path || ''}`}
                        >
                          <Github size={10} />
                          GitHub
                        </span>
                      ) : g.github_sync_status === 'modified' ? (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber-100 text-amber-800 border border-amber-300 dark:bg-amber-950/70 dark:text-amber-300 dark:border-amber-700 shrink-0"
                          title={`Local analysis modified since last GitHub sync:\n${g.github_path || 'Sync needed'}`}
                        >
                          <Github size={10} />
                          Sync Needed
                        </span>
                      ) : g.github_path ? (
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 shrink-0"
                          title={`Synced to GitHub:\n${g.github_path}`}
                        >
                          <Github size={10} />
                          GitHub
                        </span>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">
                      {g.speed_seconds ? (
                        <span>
                          {g.platform === 'chesscom'
                            ? 'chess.com'
                            : g.platform === 'lichess'
                              ? 'lichess'
                              : 'fide'}
                          : {g.speed_seconds}s
                        </span>
                      ) : null}
                      {g.speed_seconds && movesCount ? <span>·</span> : null}
                      {movesCount ? (
                        <span className="font-mono text-slate-500 dark:text-slate-400">
                          {movesCount} moves
                        </span>
                      ) : null}
                    </div>
                  </div>
                </td>

                <td className="py-3 px-3 text-center">
                  {isWhite ? (
                    <span
                      className="inline-block w-3.5 h-3.5 rounded-full border border-slate-300 dark:border-slate-400 bg-white shadow-xs align-middle"
                      title={`Playing as White (${white})`}
                    />
                  ) : isBlack ? (
                    <span
                      className="inline-block w-3.5 h-3.5 rounded-full border border-slate-700 dark:border-slate-600 bg-slate-900 shadow-xs align-middle"
                      title={`Playing as Black (${black})`}
                    />
                  ) : (
                    <span
                      className="inline-block w-3.5 h-3.5 rounded-full border border-slate-400 bg-gradient-to-r from-white to-slate-800 shadow-xs align-middle"
                      title={`Both sides: White (${white}) / Black (${black})`}
                    />
                  )}
                </td>

                <td className="py-3 px-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {white}{' '}
                      <span className="text-slate-400 dark:text-slate-500 font-normal">vs</span>{' '}
                      {black}
                    </span>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                      {formatGameTime(g.played_at, g.date, g.created_at)}
                      {movesCount ? ` · ${movesCount} moves` : ''}
                      {g.opening_name ? ` · ${g.opening_name.slice(0, 25)}` : ''}
                    </span>
                  </div>
                </td>

                <td className="py-3 px-3">
                  <Badge variant={resultBadgeVariant(g.result, g.side, white, black)}>
                    {resultLabel(g.result, g.side, white, black)}
                  </Badge>
                </td>

                <td className="py-3 px-3 text-center">
                  {isAnalyzed ? (
                    <MiniEvalChart evals={g.ply_evals} movesCount={movesCount} />
                  ) : (
                    <span className="text-slate-300 dark:text-slate-600 font-mono text-[11px]">
                      —
                    </span>
                  )}
                </td>

                <td className="py-3 px-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {isThisGameAnalyzing ? (
                      <div className="flex items-center gap-1.5">
                        <div className="w-16 bg-slate-100 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                          <div
                            className="bg-blue-600 dark:bg-blue-400 h-full transition-all duration-300"
                            style={{ width: `${activeJobProgress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate max-w-[70px]">
                          {activeJobMessage}
                        </span>
                      </div>
                    ) : isAnalyzed ? (
                      <>
                        <button
                          type="button"
                          disabled={isAnyAnalyzing}
                          onClick={() => onViewReport(g.id)}
                          title="View Report"
                          aria-label="View Report"
                          className="p-1.5 rounded-md text-slate-700 hover:text-slate-950 hover:bg-slate-100 dark:text-slate-300 dark:hover:text-white dark:hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                        >
                          <FileText size={15} />
                        </button>
                        <button
                          type="button"
                          disabled={isAnyAnalyzing}
                          onClick={() => onAnalyze(g)}
                          title="Re-run Stockfish + LLM analysis"
                          aria-label="Re-run Analysis"
                          className="p-1.5 rounded-md text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                        >
                          <RefreshCw size={14} />
                        </button>
                        {onSyncToGitHub && (
                          <button
                            type="button"
                            disabled={isAnyAnalyzing || syncingGameId === g.id}
                            onClick={() => onSyncToGitHub(g)}
                            title={
                              g.github_sync_status === 'modified'
                                ? 'Changes detected — Push update to GitHub'
                                : g.github_sync_status === 'synced'
                                  ? 'Synced to GitHub (click to push again)'
                                  : 'Sync to GitHub'
                            }
                            aria-label="Sync to GitHub"
                            className={`p-1.5 rounded-md transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer ${
                              g.github_sync_status === 'modified'
                                ? 'text-amber-600 hover:text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:text-amber-300 dark:hover:bg-amber-950/40'
                                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-slate-800'
                            }`}
                          >
                            {syncingGameId === g.id ? (
                              <RefreshCw size={14} className="animate-spin text-blue-500" />
                            ) : (
                              <Github size={14} />
                            )}
                          </button>
                        )}
                        {g.game_url && (
                          <a
                            href={g.game_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`View on ${g.platform === 'chesscom' ? 'Chess.com' : g.platform === 'lichess' ? 'Lichess' : 'Platform'}`}
                            aria-label="View on original platform"
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                          >
                            <ExternalLink size={15} />
                          </a>
                        )}
                        <button
                          type="button"
                          disabled={isAnyAnalyzing}
                          onClick={() => onDelete(g)}
                          title="Delete game record"
                          aria-label="Delete game record"
                          className="p-1.5 rounded-md text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:text-rose-300 dark:hover:bg-rose-950/40 transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          disabled={isAnyAnalyzing}
                          onClick={() => onAnalyze(g)}
                          title="Analyze Game"
                          aria-label="Analyze Game"
                          className="p-1.5 rounded-md text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:text-blue-400 dark:hover:text-blue-300 dark:hover:bg-blue-950/50 transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                        >
                          <Play size={15} />
                        </button>
                        {g.game_url && (
                          <a
                            href={g.game_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`View on ${g.platform === 'chesscom' ? 'Chess.com' : g.platform === 'lichess' ? 'Lichess' : 'Platform'}`}
                            aria-label="View on original platform"
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-800 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                          >
                            <ExternalLink size={15} />
                          </a>
                        )}
                        <button
                          type="button"
                          disabled={isAnyAnalyzing}
                          onClick={() => onDelete(g)}
                          title="Delete pending game"
                          aria-label="Delete pending game"
                          className="p-1.5 rounded-md text-rose-500 hover:text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:text-rose-300 dark:hover:bg-rose-950/40 transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
                        >
                          <Trash2 size={15} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
