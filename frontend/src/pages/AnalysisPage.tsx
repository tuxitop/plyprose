import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Sun,
  Moon,
  ExternalLink,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { resultBadgeVariant, resultLabel } from '../lib/badges';
import {
  exportPdfUrl,
  exportZipUrl,
  getAnalysis,
  getReportHtml,
  startAnalysis,
  streamJob,
} from '../lib/api';
import { classifyTimeControl, formatTC, formatGameTimeLocal } from '../lib/timeControl';
import { InteractiveBoard, type InteractiveBoardHandle } from '../components/InteractiveBoard';
import { findPlyByFen, classifyReportMove, decorateReportHtml } from '../lib/chessNav';
import type { Theme } from '../hooks/useTheme';
import type { AnalysisRecord } from '../types';

interface AnalysisPageProps {
  analysisId: number;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

export function AnalysisPage({ analysisId, theme, onToggleTheme, onBack }: AnalysisPageProps) {
  const [record, setRecord] = useState<AnalysisRecord | null>(null);
  const [reportHtml, setReportHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Interactive Chessboard sidebar state
  const [isBoardOpen, setIsBoardOpen] = useState(() => {
    return typeof window !== 'undefined' ? window.innerWidth >= 1200 : false;
  });
  const [currentPly, setCurrentPly] = useState<number>(0);
  const boardRef = useRef<InteractiveBoardHandle | null>(null);
  const [initialVariation, setInitialVariation] = useState<{
    branchPly: number;
    moves: string[];
  } | null>(null);

  // Resizable sidebar width
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('chess_sidebar_width');
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= 320 && parsed <= 800) return parsed;
    }
    return typeof window !== 'undefined' && window.innerWidth >= 1440 ? 460 : 420;
  });

  const isDraggingSidebar = useRef(false);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingSidebar.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingSidebar.current) return;
      const newWidth = window.innerWidth - moveEvent.clientX;
      const maxAllowed = Math.min(800, Math.floor(window.innerWidth * 0.65));
      const clamped = Math.max(320, Math.min(newWidth, maxAllowed));
      setSidebarWidth(clamped);
    };

    const onMouseUp = () => {
      isDraggingSidebar.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      setSidebarWidth(w => {
        localStorage.setItem('chess_sidebar_width', String(w));
        return w;
      });
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  // Auto-hiding header on scroll
  const [isHeaderVisible, setIsHeaderVisible] = useState(true);
  const lastScrollTop = useRef(0);

  const handleReportScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const currentScrollTop = e.currentTarget.scrollTop;
      const delta = currentScrollTop - lastScrollTop.current;

      if (currentScrollTop <= 35) {
        setIsHeaderVisible(true);
      } else if (delta > 20 && isHeaderVisible) {
        setIsHeaderVisible(false);
      } else if (delta < -20 && !isHeaderVisible) {
        setIsHeaderVisible(true);
      }

      lastScrollTop.current = currentScrollTop;
    },
    [isHeaderVisible],
  );

  const [reanalyzeJobId, setReanalyzeJobId] = useState<string | null>(null);
  const [reanalyzeProgress, setReanalyzeProgress] = useState(0);
  const [reanalyzeMessage, setReanalyzeMessage] = useState('');
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(() => {
      if (ignore) return;
      setLoading(true);
      setError(null);
      Promise.all([getAnalysis(analysisId), getReportHtml(analysisId)])
        .then(([rec, html]) => {
          if (!ignore) {
            setRecord(rec);
            setReportHtml(html.report_html);
          }
        })
        .catch(e => {
          if (!ignore) setError(e.message);
        })
        .finally(() => {
          if (!ignore) setLoading(false);
        });
    });
    return () => {
      ignore = true;
    };
  }, [analysisId]);

  const handleReanalyze = () => {
    if (!record?.pgn_text) return;
    startAnalysis(record.pgn_text, record.side || 'auto', record.platform || 'manual', analysisId)
      .then(({ job_id }) => {
        setReanalyzeJobId(job_id);
        setReanalyzeProgress(5);
        setReanalyzeMessage('Starting…');
        const stop = streamJob(
          job_id,
          ({ message, progress }) => {
            setReanalyzeMessage(message);
            setReanalyzeProgress(progress);
          },
          ({ analysis_id }) => {
            setReanalyzeJobId(null);
            setReanalyzeProgress(0);
            Promise.all([getAnalysis(analysis_id), getReportHtml(analysis_id)]).then(
              ([rec, html]) => {
                setRecord(rec);
                setReportHtml(html.report_html);
              },
            );
          },
          ({ message }) => {
            setReanalyzeJobId(null);
            alert(`Re-analysis failed: ${message}`);
          },
        );
        stopRef.current = stop;
      })
      .catch(e => alert(`Could not start re-analysis: ${e.message}`));
  };

  // Handle clicking on moves or board figures in the report HTML
  const handleReportClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (!target || !record?.pgn_text) return;

      // Case 1: Clicked on a board figure or inside it
      const figure = target.closest('figure.board-figure, figure[data-fen]');
      if (figure) {
        const fen = figure.getAttribute('data-fen');
        if (fen) {
          const ply = findPlyByFen(fen, record.pgn_text);
          if (ply !== -1) {
            if (boardRef.current) {
              boardRef.current.resetVariation();
            } else {
              setInitialVariation(null);
            }
            setCurrentPly(ply);
          }
          setIsBoardOpen(true);
          return;
        }
      }

      // Case 2: Clicked on a decorated move button (.chess-move-btn)
      const moveBtn = target.closest('.chess-move-btn');
      if (moveBtn) {
        const moveType = moveBtn.getAttribute('data-move-type');
        if (moveType === 'variation') {
          const branchPlyStr = moveBtn.getAttribute('data-branch-ply');
          const movesRaw = moveBtn.getAttribute('data-moves');
          if (branchPlyStr && movesRaw) {
            const branchPly = parseInt(branchPlyStr, 10);
            try {
              const moves = JSON.parse(decodeURIComponent(movesRaw)) as string[];
              if (Array.isArray(moves) && moves.length > 0) {
                if (boardRef.current) {
                  boardRef.current.startVariation(branchPly, moves);
                } else {
                  setInitialVariation({ branchPly, moves });
                }
                setCurrentPly(branchPly);
                setIsBoardOpen(true);
                return;
              }
            } catch {
              // fallback below
            }
          }
        } else if (moveType === 'mainline') {
          const plyStr = moveBtn.getAttribute('data-ply');
          if (plyStr) {
            const ply = parseInt(plyStr, 10);
            if (!isNaN(ply)) {
              if (boardRef.current) {
                boardRef.current.resetVariation();
              } else {
                setInitialVariation(null);
              }
              setCurrentPly(ply);
              setIsBoardOpen(true);
              return;
            }
          }
        }
      }

      // Case 3: Fallback for any undecorated <code> or <td> element containing chess moves
      const codeOrCell = target.closest('code, td');
      if (codeOrCell) {
        const text = (codeOrCell.textContent || '').trim();
        const navTarget = classifyReportMove(text, record.pgn_text, codeOrCell as HTMLElement);
        if (navTarget) {
          if (navTarget.type === 'variation' && navTarget.variationMoves?.length) {
            if (boardRef.current) {
              boardRef.current.startVariation(navTarget.ply, navTarget.variationMoves);
            } else {
              setInitialVariation({ branchPly: navTarget.ply, moves: navTarget.variationMoves });
            }
            setCurrentPly(navTarget.ply);
            setIsBoardOpen(true);
            return;
          } else {
            if (boardRef.current) {
              boardRef.current.resetVariation();
            } else {
              setInitialVariation(null);
            }
            setCurrentPly(navTarget.ply);
            setIsBoardOpen(true);
            return;
          }
        }
      }
    },
    [record],
  );

  const pgnText = record?.pgn_text;
  const decoratedReportHtml = useMemo(() => {
    if (!reportHtml || !pgnText) return reportHtml;
    return decorateReportHtml(reportHtml, pgnText);
  }, [reportHtml, pgnText]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full p-12 text-slate-400 dark:text-slate-500 text-sm">
        <svg
          className="animate-spin h-5 w-5 mr-2 text-slate-400 dark:text-slate-500"
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
        Loading report…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-12 gap-3">
        <p className="text-rose-600 dark:text-rose-400 text-sm">{error}</p>
        <Button variant="secondary" onClick={onBack}>
          ← Back to Games
        </Button>
      </div>
    );
  }

  if (!record) return null;

  const tc = classifyTimeControl(record.time_control, 'manual');
  const date = formatGameTimeLocal(record.played_at, record.date, record.created_at);
  const white = record.white_player;
  const black = record.black_player;

  return (
    <div className="flex flex-row min-h-0 flex-1 bg-white dark:bg-slate-950 overflow-hidden relative">
      {/* Left Column: Report Document + Collapsible Header */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
        {/* Sticky top bar that auto-hides on scroll or collapses via button */}
        <div
          className={`bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 flex flex-col z-10 shadow-xs transition-all duration-300 ease-in-out shrink-0 overflow-hidden ${
            isHeaderVisible
              ? 'max-h-60 py-3 opacity-100 gap-3'
              : 'max-h-0 py-0 opacity-0 border-none pointer-events-none'
          }`}
        >
          <div className="flex items-center justify-between">
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 w-fit transition-colors cursor-pointer"
            >
              <ArrowLeft size={14} />
              Back to Games
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsHeaderVisible(false)}
                className="flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 text-xs px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="Hide header for distraction-free reading"
              >
                <ChevronUp size={14} />
                <span>Hide Header</span>
              </button>
              <button
                onClick={onToggleTheme}
                className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 text-xs px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                aria-label="Toggle theme"
              >
                {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
                <span className="capitalize">{theme}</span>
              </button>
            </div>
          </div>

          {/* Match summary bar */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex flex-col gap-1.5 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-900 dark:text-slate-100 text-sm">
                  {white} <span className="text-slate-400 font-normal">vs</span> {black}
                </span>
                <Badge variant={resultBadgeVariant(record.result, record.side, white, black)}>
                  {resultLabel(record.result, record.side, white, black)}
                </Badge>
                <Badge variant="slate">
                  {tc.icon} {tc.label} {formatTC(record.time_control)}
                </Badge>
                {record.opening_name && <Badge variant="slate">{record.opening_name}</Badge>}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 flex-wrap">
                <span>{date}</span>
                <span>·</span>
                <span>
                  {record.moves_count ||
                  (record.total_plies ? Math.ceil(record.total_plies / 2) : 0)
                    ? `${record.moves_count || Math.ceil(record.total_plies / 2)} moves (${record.total_plies} plies)`
                    : `${record.total_plies} plies`}
                </span>
                <span>·</span>
                <span>
                  {record.critical_moments_count} critical moment
                  {record.critical_moments_count !== 1 ? 's' : ''}
                </span>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 flex-wrap">
              {reanalyzeJobId && (
                <div className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
                  <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
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
                  {reanalyzeMessage} {reanalyzeProgress}%
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                loading={Boolean(reanalyzeJobId)}
                icon={<RefreshCw size={12} />}
                onClick={handleReanalyze}
                title="Re-run Stockfish + LLM analysis"
              >
                Re-analyze
              </Button>
              {record.game_url && (
                <a
                  href={record.game_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  title={`Open original game (${record.game_url})`}
                >
                  <ExternalLink size={12} />
                  Open Game
                </a>
              )}
              {!isBoardOpen && (
                <button
                  onClick={() => setIsBoardOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Open interactive chessboard sidebar"
                >
                  <span className="text-base leading-none">♟</span>
                  Interactive Board
                </button>
              )}
              <a
                href={exportPdfUrl(analysisId)}
                download
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Download size={12} />
                PDF
              </a>
              <a
                href={exportZipUrl(analysisId)}
                download
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
              >
                <Download size={12} />
                .zip
              </a>
            </div>
          </div>
        </div>

        {/* Floating Restore Pill when header is hidden */}
        {!isHeaderVisible && (
          <div className="absolute top-3 left-6 z-20 flex items-center gap-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border border-slate-200 dark:border-slate-800 shadow-md rounded-full px-3 py-1.5 text-xs transition-all">
            <button
              onClick={onBack}
              className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
              title="Back to Games"
            >
              <ArrowLeft size={13} />
              <span>Back</span>
            </button>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200 text-[11px] max-w-[160px] sm:max-w-[240px] truncate">
              {white} vs {black}
            </span>
            <span className="text-slate-300 dark:text-slate-700">|</span>
            <button
              onClick={() => setIsHeaderVisible(true)}
              className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-medium hover:underline cursor-pointer"
              title="Show match header and export actions"
            >
              <ChevronDown size={13} />
              <span>Show Header</span>
            </button>
            {!isBoardOpen && (
              <>
                <span className="text-slate-300 dark:text-slate-700">|</span>
                <button
                  onClick={() => setIsBoardOpen(true)}
                  className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                  title="Open interactive board"
                >
                  <span className="text-xs">♟</span>
                  <span>Board</span>
                </button>
              </>
            )}
          </div>
        )}

        {/* Report document body */}
        <div
          className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950"
          onClick={handleReportClick}
          onScroll={handleReportScroll}
        >
          <div className="max-w-[860px] mx-auto px-6 py-8">
            {/* Interactive Moves Legend */}
            <div className="flex flex-wrap items-center gap-3 sm:gap-5 text-xs text-slate-500 dark:text-slate-400 pb-2.5 mb-4 border-b border-slate-200 dark:border-slate-800 select-none">
              <span className="font-semibold text-slate-700 dark:text-slate-300 text-[11px] uppercase tracking-wider">
                Interactive Moves:
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800/80 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 text-[11px] font-mono font-semibold">
                  <span className="text-[9px] text-blue-500">▶</span> Played Move
                </span>
                <span className="text-[11px]">Recorded game move</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-dashed border-purple-300 dark:border-purple-800/80 bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 text-[11px] font-mono font-semibold">
                  <span className="text-[10px] text-purple-500 font-bold">⑂</span> Variation
                </span>
                <span className="text-[11px]">Analysis & engine refutation</span>
              </span>
            </div>

            <div
              className="prose prose-slate dark:prose-invert prose-sm sm:prose-base max-w-none
                prose-headings:font-semibold
                prose-h1:text-2xl prose-h1:border-b prose-h1:border-slate-200 dark:prose-h1:border-slate-800 prose-h1:pb-3 prose-h1:mt-2
                prose-h2:text-xl prose-h2:text-blue-800 dark:prose-h2:text-blue-400 prose-h2:mt-8 prose-h2:mb-3
                prose-h3:text-lg prose-h3:text-slate-800 dark:prose-h3:text-slate-200 prose-h3:mt-6 prose-h3:mb-2
                prose-p:leading-relaxed prose-p:my-3
                prose-li:my-1
                prose-code:before:content-none prose-code:after:content-none
                prose-code:bg-slate-100 dark:prose-code:bg-slate-800 prose-code:text-slate-900 dark:prose-code:text-slate-100 prose-code:border prose-code:border-slate-200 dark:prose-code:border-slate-700/60 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono prose-code:font-semibold
                prose-pre:bg-slate-900 dark:prose-pre:bg-slate-900 prose-pre:text-slate-100 prose-pre:text-xs prose-pre:rounded-lg prose-pre:p-4
                prose-blockquote:border-l-4 prose-blockquote:border-blue-500 prose-blockquote:bg-blue-50 dark:prose-blockquote:bg-blue-950/40 prose-blockquote:text-blue-900 dark:prose-blockquote:text-blue-200 prose-blockquote:not-italic prose-blockquote:py-2 prose-blockquote:px-4 prose-blockquote:rounded-r
                prose-table:w-full prose-table:text-xs prose-table:my-4 prose-table:border-collapse
                prose-th:bg-slate-100 dark:prose-th:bg-slate-800 prose-th:p-2 prose-th:border prose-th:border-slate-200 dark:prose-th:border-slate-700 prose-th:text-left
                prose-td:p-2 prose-td:border prose-td:border-slate-200 dark:prose-td:border-slate-700
                prose-figure:my-6 prose-figure:flex prose-figure:flex-col prose-figure:items-center
                prose-figcaption:text-center prose-figcaption:text-xs prose-figcaption:text-slate-500 dark:prose-figcaption:text-slate-400 prose-figcaption:mt-2 prose-figcaption:italic"
              dangerouslySetInnerHTML={{ __html: decoratedReportHtml }}
            />
          </div>
        </div>
      </div>

      {/* Interactive Board Sidebar - full viewport height! */}
      {isBoardOpen && (
        <aside
          style={{ width: `${sidebarWidth}px` }}
          className="h-full w-full sm:w-[var(--sidebar-width)] max-w-full border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col shrink-0 overflow-hidden shadow-xl z-20 absolute inset-y-0 right-0 sm:relative transition-none"
        >
          {/* Draggable Vertical Splitter Handle on Left Border */}
          <div
            onMouseDown={handleSidebarResizeStart}
            className="hidden sm:flex absolute left-0 top-0 bottom-0 w-2.5 -ml-1 cursor-col-resize z-30 group items-center justify-center hover:bg-blue-500/20 active:bg-blue-500/40 transition-colors select-none"
            title="Drag to resize sidebar width"
          >
            <div className="w-0.5 h-10 rounded-full bg-slate-300 dark:bg-slate-700 group-hover:bg-blue-500 group-active:bg-blue-600 transition-colors" />
          </div>

          <InteractiveBoard
            ref={boardRef}
            pgnText={record.pgn_text}
            payloadJson={record.payload_json}
            currentPly={currentPly}
            onSelectPly={setCurrentPly}
            onClose={() => {
              setIsBoardOpen(false);
              setInitialVariation(null);
            }}
            userSide={record.side || (record.white_player === 'tuxitop' ? 'white' : 'black')}
            sidebarWidth={sidebarWidth}
            initialVariation={initialVariation}
          />
        </aside>
      )}
    </div>
  );
}
