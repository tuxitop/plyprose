import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  Download,
  Info,
  RefreshCw,
  Sun,
  Moon,
  ExternalLink,
  ChevronUp,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
  Zap,
  Settings as SettingsIcon,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { TagCapsule } from '../components/TagCapsule';
import { resultBadgeVariant, resultLabel, sortTagsNegativeFirst } from '../lib/badges';
import {
  cancelJob,
  exportPdfUrl,
  exportZipUrl,
  getAnalysis,
  getReportHtml,
  isDirectMode,
  startAnalysis,
  streamJob,
} from '../lib/api';
import { downloadGitHubDirectPdf } from '../lib/githubDirect';
import { classifyTimeControl, formatTC, formatGameTimeLocal } from '../lib/timeControl';
import { InteractiveBoard, type InteractiveBoardHandle } from '../components/InteractiveBoard';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { findPlyByFen, classifyReportMove, decorateReportHtml } from '../lib/chessNav';
import type { Theme } from '../hooks/useTheme';
import type { AnalysisRecord } from '../types';

export type MobileViewMode = 'split' | 'report' | 'board';

interface AnalysisPageProps {
  analysisId: number | string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

export function AnalysisPage({ analysisId, theme, onToggleTheme, onBack }: AnalysisPageProps) {
  const [record, setRecord] = useState<AnalysisRecord | null>(null);
  const [reportHtml, setReportHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingDirectPdf, setDownloadingDirectPdf] = useState(false);
  const [isMobileDetailsOpen, setIsMobileDetailsOpen] = useState(false);

  // Interactive Chessboard sidebar state: default to closed on mobile screens (<640px)
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 640;
  });

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 640);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const [isBoardOpen, setIsBoardOpen] = useState(
    () => !(typeof window !== 'undefined' && window.innerWidth < 640),
  );
  const [mobileView, setMobileView] = useState<MobileViewMode>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) {
      const saved = localStorage.getItem('chess_mobile_view');
      if (saved === 'split' || saved === 'report' || saved === 'board') return saved;
      return 'report';
    }
    return 'report';
  });

  const [isLiveAnalyzing, setIsLiveAnalyzing] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('chess_live_analysis') === 'true';
    }
    return false;
  });

  const handleMobileToggleAnalysis = useCallback(() => {
    boardRef.current?.toggleAnalysis?.();
  }, []);

  const handleMobileToggleSettings = useCallback(() => {
    boardRef.current?.toggleSettings?.();
  }, []);

  const handleSetMobileView = (mode: MobileViewMode) => {
    setMobileView(mode);
    localStorage.setItem('chess_mobile_view', mode);
    if (mode === 'board' || mode === 'split') {
      setIsBoardOpen(true);
    }
    if (mode === 'board') {
      setIsHeaderVisible(true);
    }
  };

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
  const reportContainerRef = useRef<HTMLDivElement | null>(null);

  const handleReportUpdated = useCallback((newHtml: string, newMd: string) => {
    setReportHtml(newHtml);
    setRecord(prev => (prev ? { ...prev, report_md: newMd } : null));
  }, []);

  const handlePgnUpdated = useCallback((newPgn: string) => {
    setRecord(prev => (prev ? { ...prev, pgn_text: newPgn } : null));
  }, []);

  const handleScrollToSection = useCallback((sectionName: string) => {
    const container = reportContainerRef.current;
    if (!container) return;
    const headings = container.querySelectorAll('h1, h2, h3, h4');
    for (const h of headings) {
      if (h.textContent?.toLowerCase().includes(sectionName.toLowerCase())) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        h.classList.add('bg-amber-100', 'dark:bg-amber-900/40', 'transition-colors');
        setTimeout(() => {
          h.classList.remove('bg-amber-100', 'dark:bg-amber-900/40');
        }, 2500);
        break;
      }
    }
  }, []);

  const handleDownloadPdf = useCallback(async () => {
    if (isDirectMode()) {
      setDownloadingDirectPdf(true);
      try {
        await downloadGitHubDirectPdf(analysisId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to download PDF';
        alert(msg);
      } finally {
        setDownloadingDirectPdf(false);
      }
    } else {
      const link = document.createElement('a');
      link.href = exportPdfUrl(analysisId);
      link.download = `analysis_${analysisId}.pdf`;
      link.click();
    }
  }, [analysisId]);

  const handleReportScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      // Auto-hide header only on desktop/tablet screens (>= 640px).
      // On mobile, header visibility is explicitly controlled by the user's Hide/Show buttons
      // to prevent erratic scroll jitter and unwanted pop-ups while reading.
      if (typeof window !== 'undefined' && window.innerWidth < 640) {
        return;
      }
      const currentScrollTop = e.currentTarget.scrollTop;
      const delta = currentScrollTop - lastScrollTop.current;

      if (currentScrollTop <= 35) {
        setIsHeaderVisible(true);
      } else if (delta > 20) {
        setIsHeaderVisible(false);
      } else if (delta < -20) {
        setIsHeaderVisible(true);
      }

      lastScrollTop.current = currentScrollTop;
    },
    [setIsHeaderVisible],
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

  const handleCancelReanalyze = async () => {
    if (!reanalyzeJobId) return;
    try {
      if (stopRef.current) {
        stopRef.current();
        stopRef.current = null;
      }
      await cancelJob(reanalyzeJobId);
    } catch (e) {
      console.error('Failed to cancel re-analysis:', e);
    } finally {
      setReanalyzeJobId(null);
      setReanalyzeProgress(0);
      setReanalyzeMessage('');
    }
  };

  const handleReanalyze = (skipEngine = true) => {
    if (!record?.pgn_text) return;
    startAnalysis(
      record.pgn_text,
      record.side || 'auto',
      record.platform || 'manual',
      record.id,
      undefined,
      skipEngine,
    )
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

  const openBoardOnMobile = useCallback(() => {
    setIsBoardOpen(true);
    if (typeof window !== 'undefined' && window.innerWidth < 640) {
      setMobileView(prev => (prev === 'report' ? 'split' : prev));
    }
  }, [setIsBoardOpen, setMobileView]);

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
          openBoardOnMobile();
          return;
        }
      }

      // Case 2: Clicked on a chessboard square pill (.chess-square-pill)
      const sqPill = target.closest('.chess-square-pill');
      if (sqPill) {
        const sq = sqPill.getAttribute('data-square');
        if (sq) {
          openBoardOnMobile();
          boardRef.current?.highlightSquare?.(sq);
        }
        return;
      }

      // Case 3: Clicked on a decorated move button (.chess-move-btn)
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
                openBoardOnMobile();
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
              openBoardOnMobile();
              return;
            }
          }
        }
      }

      // Case 4: Fallback for any undecorated <code> or <td> element containing chess moves or squares
      const codeOrCell = target.closest('code, td');
      if (codeOrCell) {
        const text = (codeOrCell.textContent || '').trim();
        if (/^[a-h][1-8]$/i.test(text)) {
          openBoardOnMobile();
          boardRef.current?.highlightSquare?.(text);
          return;
        }
        const navTarget = classifyReportMove(text, record.pgn_text, codeOrCell as HTMLElement);
        if (navTarget) {
          if (navTarget.type === 'variation' && navTarget.variationMoves?.length) {
            if (boardRef.current) {
              boardRef.current.startVariation(navTarget.ply, navTarget.variationMoves);
            } else {
              setInitialVariation({ branchPly: navTarget.ply, moves: navTarget.variationMoves });
            }
            setCurrentPly(navTarget.ply);
            openBoardOnMobile();
            return;
          } else {
            if (boardRef.current) {
              boardRef.current.resetVariation();
            } else {
              setInitialVariation(null);
            }
            setCurrentPly(navTarget.ply);
            openBoardOnMobile();
            return;
          }
        }
      }
    },
    [record, openBoardOnMobile, setCurrentPly, setInitialVariation],
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
        {/* Dedicated Mobile Header (< sm breakpoint, strictly in document flow, never overlaps) */}
        {isHeaderVisible && (
          <div className="flex sm:hidden flex-col bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0 z-30 shadow-xs">
            {/* Top Bar: Back | Matchup & Result | Actions */}
            <div className="flex items-center justify-between px-3 h-12 gap-2 border-b border-slate-100 dark:border-slate-800/60">
              {/* Left: Back Button */}
              <button
                onClick={onBack}
                className="flex items-center justify-center p-2 -ml-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white rounded-lg active:bg-slate-100 dark:active:bg-slate-800 transition-colors cursor-pointer"
                title="Back to Games"
                aria-label="Back to Games"
              >
                <ArrowLeft size={18} />
              </button>

              {/* Center: Matchup & Result Badge */}
              <div className="flex items-center gap-1.5 min-w-0 flex-1 justify-center">
                <span className="font-bold text-xs text-slate-900 dark:text-slate-100 truncate max-w-[130px]">
                  {white} <span className="text-slate-400 font-normal">vs</span> {black}
                </span>
                <Badge variant={resultBadgeVariant(record.result, record.side, white, black)}>
                  {resultLabel(record.result, record.side, white, black)}
                </Badge>
              </div>

              {/* Right: Info toggle + Quick Actions + Theme + Hide Headers */}
              <div className="flex items-center gap-1 shrink-0">
                {/* Details Drawer Toggle */}
                <button
                  type="button"
                  onClick={() => setIsMobileDetailsOpen(prev => !prev)}
                  className={`p-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                    isMobileDetailsOpen
                      ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                  title={
                    isMobileDetailsOpen ? 'Hide match details' : 'Show match details & actions'
                  }
                  aria-label="Toggle match details"
                >
                  <Info size={16} />
                </button>

                {/* PDF Quick Download */}
                <button
                  type="button"
                  onClick={handleDownloadPdf}
                  disabled={downloadingDirectPdf}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                  title="Download PDF report"
                  aria-label="Download PDF report"
                >
                  <Download
                    size={16}
                    className={downloadingDirectPdf ? 'animate-bounce text-blue-600' : ''}
                  />
                </button>

                {/* Theme Toggle */}
                <button
                  onClick={onToggleTheme}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Toggle theme"
                  aria-label="Toggle theme"
                >
                  {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                </button>

                {/* Hide Both Headers for Immersive Reading */}
                <button
                  type="button"
                  onClick={() => setIsHeaderVisible(false)}
                  className="p-2 rounded-lg text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                  title="Hide headers for distraction-free reading"
                  aria-label="Hide headers"
                >
                  <ChevronUp size={16} />
                </button>
              </div>
            </div>

            {/* Mobile Collapsible Details Drawer (Tags, Opening, TC, Date, Re-analyze, External Link) */}
            {isMobileDetailsOpen && (
              <div className="px-3 py-2.5 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-800 text-xs flex flex-col gap-2 transition-all">
                {/* Opening & Time Control */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant="slate">
                    {tc.icon} {tc.label} {formatTC(record.time_control)}
                  </Badge>
                  {record.opening_name && (
                    <Badge variant="slate" className="truncate max-w-[240px]">
                      {record.opening_name}
                    </Badge>
                  )}
                </div>

                {/* Tags */}
                {record.tags && record.tags.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {sortTagsNegativeFirst(record.tags).map(tag => (
                      <TagCapsule key={tag} tag={tag} />
                    ))}
                  </div>
                )}

                {/* Meta info: Date · moves · critical moments */}
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 dark:text-slate-500 flex-wrap">
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

                {/* Action buttons on mobile */}
                <div className="flex items-center gap-2 pt-1 border-t border-slate-200/60 dark:border-slate-700/60 flex-wrap">
                  {reanalyzeJobId && (
                    <div className="flex items-center gap-1.5 text-xs text-blue-700 dark:text-blue-300">
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
                      <span>
                        {reanalyzeMessage} {reanalyzeProgress}%
                      </span>
                      <button
                        type="button"
                        onClick={handleCancelReanalyze}
                        className="px-2 py-0.5 text-xs font-medium text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-200 border border-rose-200 dark:border-rose-800 rounded bg-rose-50/50 dark:bg-rose-950/40 transition-colors cursor-pointer"
                        title="Cancel re-analysis"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {!isDirectMode() && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={Boolean(reanalyzeJobId)}
                      icon={<RefreshCw size={12} />}
                      onClick={() => handleReanalyze(true)}
                      title="Re-run LLM coach narrative (default, fast)"
                    >
                      Re-analyze
                    </Button>
                  )}
                  {record.game_url && (
                    <a
                      href={record.game_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <ExternalLink size={12} />
                      <span>Open Game</span>
                    </a>
                  )}
                  {!isDirectMode() && (
                    <a
                      href={exportZipUrl(analysisId)}
                      download
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <Download size={12} />
                      <span>.zip</span>
                    </a>
                  )}
                </div>
              </div>
            )}

            {/* Mobile View Switcher (Split / Report / Board) & Engine Controls */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-slate-100 dark:bg-slate-900/90 gap-2">
              <div className="flex items-center w-full max-w-[210px] sm:max-w-sm p-0.5 rounded-lg bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 select-none shadow-xs">
                <button
                  type="button"
                  onClick={() => handleSetMobileView('split')}
                  className={`flex-1 py-1 px-1.5 text-xs font-semibold rounded-md transition-all flex items-center justify-center gap-1 cursor-pointer ${
                    mobileView === 'split'
                      ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <span>📖</span>
                  <span>Split</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetMobileView('report')}
                  className={`flex-1 py-1 px-1.5 text-xs font-semibold rounded-md transition-all flex items-center justify-center gap-1 cursor-pointer ${
                    mobileView === 'report'
                      ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <span>📜</span>
                  <span>Report</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSetMobileView('board')}
                  className={`flex-1 py-1 px-1.5 text-xs font-semibold rounded-md transition-all flex items-center justify-center gap-1 cursor-pointer ${
                    mobileView === 'board'
                      ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  <span>♟️</span>
                  <span>Board</span>
                </button>
              </div>

              {/* Quick Engine & Board controls on mobile (visible in split and board modes) */}
              {mobileView !== 'report' ? (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={handleMobileToggleAnalysis}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                      isLiveAnalyzing
                        ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs'
                        : 'bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-300 dark:border-slate-700'
                    }`}
                    title="Toggle in-browser Stockfish 19 live analysis"
                  >
                    <Zap
                      size={12}
                      className={
                        isLiveAnalyzing ? 'animate-pulse text-amber-300' : 'text-slate-400'
                      }
                    />
                    <span>SF 19</span>
                    <span className="text-[10px] font-normal opacity-90">
                      {isLiveAnalyzing ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={handleMobileToggleSettings}
                    title="Board & Engine settings"
                    className="p-1.5 rounded-md text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 bg-slate-200/80 dark:bg-slate-800/80 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    aria-label="Board and engine settings"
                  >
                    <SettingsIcon size={14} />
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsHeaderVisible(false)}
                    title="Hide headers for distraction-free reading"
                    className="p-1.5 rounded-md text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 bg-slate-200/80 dark:bg-slate-800/80 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    aria-label="Hide headers"
                  >
                    <ChevronUp size={14} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsHeaderVisible(false)}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 bg-slate-200/80 dark:bg-slate-800/80 hover:bg-slate-300 dark:hover:bg-slate-700 rounded-md transition-colors cursor-pointer shrink-0"
                  title="Hide headers for distraction-free reading"
                >
                  <ChevronUp size={13} />
                  <span>Hide</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Desktop Collapsible Header (>= sm breakpoint) */}
        <div
          className={`hidden sm:flex bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-6 flex-col z-10 shadow-xs transition-all duration-300 ease-in-out shrink-0 overflow-hidden ${
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
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
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
              {record.tags && record.tags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                  {sortTagsNegativeFirst(record.tags).map(tag => (
                    <TagCapsule key={tag} tag={tag} />
                  ))}
                </div>
              )}
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

            <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
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
                  <span>
                    {reanalyzeMessage} {reanalyzeProgress}%
                  </span>
                  <button
                    type="button"
                    onClick={handleCancelReanalyze}
                    className="px-2 py-0.5 text-xs font-medium text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-200 border border-rose-200 dark:border-rose-800 rounded bg-rose-50/50 dark:bg-rose-950/40 transition-colors cursor-pointer"
                    title="Cancel re-analysis"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {!isDirectMode() && (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={Boolean(reanalyzeJobId)}
                  icon={<RefreshCw size={12} />}
                  onClick={() => handleReanalyze(true)}
                  title="Re-run LLM coach narrative (default, fast)"
                >
                  Re-analyze
                </Button>
              )}
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
              {isDirectMode() ? (
                <button
                  type="button"
                  onClick={handleDownloadPdf}
                  disabled={downloadingDirectPdf}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                  title="Download PDF report directly from GitHub repository"
                >
                  <Download size={12} className={downloadingDirectPdf ? 'animate-bounce' : ''} />
                  {downloadingDirectPdf ? 'Downloading…' : 'PDF'}
                </button>
              ) : (
                <a
                  href={exportPdfUrl(analysisId)}
                  download
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <Download size={12} />
                  PDF
                </a>
              )}
              {!isDirectMode() && (
                <a
                  href={exportZipUrl(analysisId)}
                  download
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <Download size={12} />
                  .zip
                </a>
              )}
              {/* Dedicated Sidebar Toggle Button at the header edge */}
              <button
                onClick={() => setIsBoardOpen(prev => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm font-medium transition-colors cursor-pointer ${
                  isBoardOpen
                    ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60'
                    : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
                title={isBoardOpen ? 'Hide interactive board' : 'Show interactive board'}
                aria-label={isBoardOpen ? 'Hide interactive board' : 'Show interactive board'}
              >
                {isBoardOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
                <span className="hidden sm:inline">
                  {isBoardOpen ? 'Hide Board' : 'Show Board'}
                </span>
              </button>
            </div>
          </div>
        </div>

        {/* Floating Restore Pill when header is hidden on desktop */}
        {!isHeaderVisible && (
          <div className="hidden sm:flex absolute top-3 left-6 z-30 items-center justify-start gap-2 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border border-slate-200 dark:border-slate-800 shadow-md rounded-full px-3 py-1.5 text-xs transition-all">
            <div className="flex items-center gap-1.5 min-w-0">
              <button
                onClick={onBack}
                className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
                title="Back to Games"
              >
                <ArrowLeft size={13} />
                <span>Back</span>
              </button>
              <span className="text-slate-300 dark:text-slate-700">|</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200 text-[11px] max-w-[240px] truncate">
                {white} vs {black}
              </span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => setIsHeaderVisible(true)}
                className="flex items-center gap-1 text-blue-600 dark:text-blue-400 font-medium hover:underline cursor-pointer"
                title="Show match header and export actions"
              >
                <ChevronDown size={13} />
                <span>Show Header</span>
              </button>
              <span className="text-slate-300 dark:text-slate-700">|</span>
              <button
                onClick={() => setIsBoardOpen(prev => !prev)}
                className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                title={isBoardOpen ? 'Hide interactive board' : 'Show interactive board'}
              >
                {isBoardOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
                <span>{isBoardOpen ? 'Hide Board' : 'Show Board'}</span>
              </button>
            </div>
          </div>
        )}

        {/* Floating Restore Pill on mobile when header is hidden (fixed at bottom, never blocks board or top text) */}
        {!isHeaderVisible && isMobile && (
          <div className="sm:hidden fixed bottom-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-slate-900/95 dark:bg-slate-800/95 text-white backdrop-blur-md border border-slate-700/80 shadow-2xl rounded-full px-3 py-1.5 text-xs whitespace-nowrap select-none transition-all animate-in fade-in slide-in-from-bottom-2 duration-150">
            <button
              onClick={onBack}
              className="flex items-center gap-1.5 font-medium text-slate-300 hover:text-white transition-colors cursor-pointer shrink-0 px-2 py-1 rounded-full hover:bg-slate-800/80 active:bg-slate-700/80"
              title="Back to Games"
              aria-label="Back to Games"
            >
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>

            <span className="w-px h-3.5 bg-slate-700 shrink-0 select-none" aria-hidden="true" />

            <button
              onClick={() => setIsHeaderVisible(true)}
              className="inline-flex items-center gap-1 font-semibold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer shrink-0 px-2.5 py-1 rounded-full hover:bg-slate-800/80 active:bg-slate-700/80"
              title="Show match header and controls"
              aria-label="Show match header and controls"
            >
              <ChevronDown size={14} />
              <span>Show Headers</span>
            </button>

            <span className="w-px h-3.5 bg-slate-700 shrink-0 select-none" aria-hidden="true" />

            <button
              onClick={() => {
                if (mobileView === 'report') {
                  handleSetMobileView('split');
                } else {
                  handleSetMobileView('report');
                }
              }}
              className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-800/90 hover:bg-slate-700 active:bg-slate-600 border border-slate-700/70 text-slate-200 hover:text-white transition-all cursor-pointer shrink-0 shadow-xs"
              title={
                mobileView === 'report'
                  ? 'Show interactive board (split view)'
                  : 'Show full report document'
              }
              aria-label={
                mobileView === 'report' ? 'Show interactive board' : 'Show full report document'
              }
            >
              <span className="leading-none select-none text-[15px]" role="img" aria-hidden="true">
                {mobileView === 'report' ? '♟️' : '📜'}
              </span>
            </button>
          </div>
        )}

        {/* On Mobile: Top Docked Board in Split Mode */}
        {isMobile && mobileView === 'split' && (
          <div className="sm:hidden w-full shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm flex flex-col z-20 overflow-hidden">
            <ErrorBoundary fallbackTitle="Could not display chessboard">
              <InteractiveBoard
                ref={boardRef}
                pgnText={record.pgn_text}
                payloadJson={record.payload_json}
                currentPly={currentPly}
                onSelectPly={setCurrentPly}
                onClose={() => handleSetMobileView('report')}
                userSide={record.side || (record.white_player === 'tuxitop' ? 'white' : 'black')}
                sidebarWidth={sidebarWidth}
                initialVariation={initialVariation}
                analysisId={analysisId}
                onReportUpdated={handleReportUpdated}
                onScrollToSection={handleScrollToSection}
                isMobileDocked={true}
                hideHeader={true}
                onAnalysisToggled={setIsLiveAnalyzing}
                onPgnUpdated={handlePgnUpdated}
                githubPath={record.github_path || undefined}
              />
            </ErrorBoundary>
          </div>
        )}

        {/* On Mobile: Full Interactive Board in Board Mode */}
        {isMobile && mobileView === 'board' ? (
          <div className="sm:hidden flex-1 h-full overflow-hidden bg-white dark:bg-slate-900">
            <ErrorBoundary fallbackTitle="Could not display chessboard">
              <InteractiveBoard
                ref={boardRef}
                pgnText={record.pgn_text}
                payloadJson={record.payload_json}
                currentPly={currentPly}
                onSelectPly={setCurrentPly}
                onClose={() => handleSetMobileView('report')}
                userSide={record.side || (record.white_player === 'tuxitop' ? 'white' : 'black')}
                sidebarWidth={sidebarWidth}
                initialVariation={initialVariation}
                analysisId={analysisId}
                onReportUpdated={handleReportUpdated}
                onScrollToSection={handleScrollToSection}
                isMobileDocked={false}
                hideHeader={true}
                onAnalysisToggled={setIsLiveAnalyzing}
                onPgnUpdated={handlePgnUpdated}
                githubPath={record.github_path || undefined}
              />
            </ErrorBoundary>
          </div>
        ) : (
          /* Report document body */
          <div
            ref={reportContainerRef}
            className={`flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 pb-safe ${
              !isHeaderVisible ? 'pb-24 sm:pb-safe' : ''
            }`}
            onClick={handleReportClick}
            onScroll={handleReportScroll}
          >
            <div className="max-w-[860px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
              {/* Interactive Moves Legend */}
              <div className="flex flex-wrap items-center gap-2 sm:gap-5 text-xs text-slate-500 dark:text-slate-400 pb-2.5 mb-4 border-b border-slate-200 dark:border-slate-800 select-none">
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
        )}
      </div>

      {/* Desktop Interactive Board Sidebar (>= sm breakpoint) */}
      {!isMobile && isBoardOpen && (
        <aside
          style={{ width: `${sidebarWidth}px` }}
          className="hidden sm:flex h-full w-[var(--sidebar-width)] max-w-full border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex-col shrink-0 overflow-hidden shadow-xl z-20 relative transition-none"
        >
          {/* Draggable Vertical Splitter Handle on Left Border */}
          <div
            onMouseDown={handleSidebarResizeStart}
            className="hidden sm:flex absolute left-0 top-0 bottom-0 w-2.5 -ml-1 cursor-col-resize z-30 group items-center justify-center hover:bg-blue-500/20 active:bg-blue-500/40 transition-colors select-none"
            title="Drag to resize sidebar width"
          >
            <div className="w-0.5 h-10 rounded-full bg-slate-300 dark:bg-slate-700 group-hover:bg-blue-500 group-active:bg-blue-600 transition-colors" />
          </div>

          <ErrorBoundary fallbackTitle="Could not display chessboard sidebar">
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
              analysisId={analysisId}
              onReportUpdated={handleReportUpdated}
              onScrollToSection={handleScrollToSection}
              isMobileDocked={false}
              hideHeader={false}
              onAnalysisToggled={setIsLiveAnalyzing}
              onPgnUpdated={handlePgnUpdated}
              githubPath={record.github_path || undefined}
            />
          </ErrorBoundary>
        </aside>
      )}
    </div>
  );
}
