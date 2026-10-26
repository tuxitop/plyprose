import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Upload, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { FilterBar } from '../components/FilterBar';
import { GamesTable } from '../components/GamesTable';
import { ImportModal } from '../components/ImportModal';
import { Modal } from '../components/Modal';
import { PlatformImportModal } from '../components/PlatformImportModal';
import { deleteGame, getGames, startAnalysis, streamJob, syncGameToGitHub } from '../lib/api';
import type { CategoryFilter, GameRecord, Platform, ResultFilter, StatusFilter } from '../types';

interface GamesPageProps {
  onViewReport: (id: number) => void;
}

export function GamesPage({ onViewReport }: GamesPageProps) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [result, setResult] = useState<ResultFilter>('all');
  const [platform, setPlatform] = useState<Platform>('all');
  const [category, setCategory] = useState<CategoryFilter>('all');

  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);

  const [games, setGames] = useState<GameRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeGameKey, setActiveGameKey] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState(0);
  const [jobMessage, setJobMessage] = useState('');
  const stopStreamRef = useRef<(() => void) | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [platformImportOpen, setPlatformImportOpen] = useState(false);
  const [gameToDelete, setGameToDelete] = useState<GameRecord | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [syncingGameId, setSyncingGameId] = useState<number | null>(null);
  const [syncMessage, setSyncMessage] = useState<{ text: string; isError?: boolean } | null>(null);

  const fetchGames = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, page_size: pageSize };
      if (status !== 'all') params.status = status;
      if (result !== 'all') params.result = result;
      if (platform !== 'all') params.platform = platform;
      if (category !== 'all') params.category = category;
      const data = await getGames(params);
      setGames(data.games);
      setTotal(data.total);
      setPages(data.pages);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, status, result, platform, category]);

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(() => {
      if (!ignore) fetchGames();
    });
    return () => {
      ignore = true;
    };
  }, [fetchGames]);

  const handleStatusChange = (s: StatusFilter) => {
    setStatus(s);
    setPage(1);
  };
  const handleResultChange = (r: ResultFilter) => {
    setResult(r);
    setPage(1);
  };
  const handlePlatformChange = (p: Platform) => {
    setPlatform(p);
    setPage(1);
  };
  const handleCategoryChange = (c: CategoryFilter) => {
    setCategory(c);
    setPage(1);
  };

  const handleDelete = (game: GameRecord) => {
    setGameToDelete(game);
  };

  const confirmDelete = async () => {
    if (!gameToDelete) return;
    setIsDeleting(true);
    try {
      const isPending = !gameToDelete.analyzed && !gameToDelete.report_md;
      await deleteGame(gameToDelete.id, isPending);
      setGameToDelete(null);
      fetchGames();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Could not delete game: ${msg}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const runAnalysis = (
    pgn: string,
    side: string,
    plat: string,
    existingId?: number,
    pendingId?: number,
  ) => {
    const gameKey = existingId ? `a-${existingId}` : pendingId ? `p-${pendingId}` : null;
    setActiveGameKey(gameKey);
    startAnalysis(pgn, side, plat, existingId, pendingId)
      .then(({ job_id }) => {
        setActiveJobId(job_id);
        setJobProgress(5);
        setJobMessage('Starting…');
        const stop = streamJob(
          job_id,
          ({ message, progress }) => {
            setJobMessage(message);
            setJobProgress(progress);
          },
          ({ analysis_id }) => {
            setActiveJobId(null);
            setActiveGameKey(null);
            setJobProgress(0);
            fetchGames();
            if (analysis_id) onViewReport(analysis_id);
          },
          ({ message }) => {
            setActiveJobId(null);
            setActiveGameKey(null);
            setJobProgress(0);
            alert(`Analysis failed: ${message}`);
          },
        );
        stopStreamRef.current = stop;
      })
      .catch(e => {
        setActiveGameKey(null);
        alert(`Could not start analysis: ${e.message}`);
      });
  };

  const handleAnalyze = (game: GameRecord) => {
    if (!game.pgn_text) {
      alert('PGN not available for this record.');
      return;
    }
    const isAnalyzed = game.analyzed ?? Boolean(game.report_md);
    runAnalysis(
      game.pgn_text,
      game.side || 'auto',
      game.platform ?? 'manual',
      isAnalyzed ? game.id : undefined,
      !isAnalyzed ? game.id : undefined,
    );
  };

  const handleImportDone = (pgn: string, side: string, plat: string, pendingId?: number) => {
    // Game is already saved to pending table by the backend import endpoint; refresh & run analysis
    fetchGames();
    runAnalysis(pgn, side, plat, undefined, pendingId);
  };

  const handleSyncToGitHub = async (game: GameRecord) => {
    if (!game.id) return;
    setSyncingGameId(game.id);
    setSyncMessage(null);
    try {
      const res = await syncGameToGitHub(game.id);
      if (res.ok) {
        if (res.already_synced) {
          setSyncMessage({ text: 'Game is already up to date on GitHub.' });
        } else {
          setSyncMessage({ text: 'Game synced to GitHub successfully!' });
        }
        await fetchGames();
      } else {
        setSyncMessage({ text: res.message || 'GitHub sync failed.', isError: true });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'GitHub sync failed.';
      setSyncMessage({ text: msg, isError: true });
    } finally {
      setSyncingGameId(null);
      setTimeout(() => setSyncMessage(null), 4000);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">My Games</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            icon={<Download size={13} />}
            onClick={() => setPlatformImportOpen(true)}
          >
            Import from Platform
          </Button>
          <Button variant="primary" icon={<Upload size={13} />} onClick={() => setImportOpen(true)}>
            Import PGN
          </Button>
        </div>
      </div>

      {activeJobId && (
        <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-2.5 flex items-center gap-3">
          <svg
            className="animate-spin h-4 w-4 text-blue-500 shrink-0"
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
          <div className="flex-1">
            <p className="text-xs font-medium text-blue-900 dark:text-blue-200">{jobMessage}</p>
            <div className="mt-1 h-1 bg-blue-200 dark:bg-blue-900 rounded-full overflow-hidden w-48">
              <div
                className="h-full bg-blue-600 dark:bg-blue-400 transition-all duration-500 rounded-full"
                style={{ width: `${jobProgress}%` }}
              />
            </div>
          </div>
          <span className="text-xs text-blue-700 dark:text-blue-300 font-mono">{jobProgress}%</span>
        </div>
      )}

      {syncMessage && (
        <div
          className={`rounded-lg px-4 py-2 text-xs font-medium border flex items-center justify-between transition-all ${
            syncMessage.isError
              ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-200'
              : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
          }`}
        >
          <span>{syncMessage.text}</span>
          <button
            type="button"
            onClick={() => setSyncMessage(null)}
            className="text-xs opacity-60 hover:opacity-100 ml-2 cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      <FilterBar
        status={status}
        result={result}
        platform={platform}
        category={category}
        onStatus={handleStatusChange}
        onResult={handleResultChange}
        onPlatform={handlePlatformChange}
        onCategory={handleCategoryChange}
      />

      <GamesTable
        games={games}
        loading={loading}
        activeJobId={activeJobId}
        activeGameKey={activeGameKey}
        activeJobProgress={jobProgress}
        activeJobMessage={jobMessage}
        onViewReport={onViewReport}
        onAnalyze={handleAnalyze}
        onDelete={handleDelete}
        onSyncToGitHub={handleSyncToGitHub}
        syncingGameId={syncingGameId}
      />

      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>
            {total} total game{total !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              icon={<ChevronLeft size={12} />}
            >
              Prev
            </Button>
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {page} / {pages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= pages}
              onClick={() => setPage(p => Math.min(pages, p + 1))}
            >
              Next <ChevronRight size={12} className="inline" />
            </Button>
          </div>
        </div>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImportDone={handleImportDone}
      />

      <PlatformImportModal
        open={platformImportOpen}
        onClose={() => setPlatformImportOpen(false)}
        onImportDone={fetchGames}
      />

      <Modal
        open={Boolean(gameToDelete)}
        onClose={() => !isDeleting && setGameToDelete(null)}
        title="Delete Game"
        width="max-w-md"
      >
        {gameToDelete && (
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-full bg-rose-100 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 shrink-0">
                <Trash2 size={20} />
              </div>
              <div className="space-y-1">
                <p className="text-sm text-slate-800 dark:text-slate-200">
                  Are you sure you want to delete this{' '}
                  {(gameToDelete.analyzed ?? Boolean(gameToDelete.report_md))
                    ? 'game and its analysis report'
                    : 'pending game'}
                  ?
                </p>
                <div className="text-xs text-slate-500 dark:text-slate-400 font-medium">
                  {gameToDelete.white_player || gameToDelete.white || 'White'} vs{' '}
                  {gameToDelete.black_player || gameToDelete.black || 'Black'}
                </div>
                <p className="text-xs text-rose-600 dark:text-rose-400">
                  This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button
                variant="secondary"
                size="sm"
                disabled={isDeleting}
                onClick={() => setGameToDelete(null)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={isDeleting}
                loading={isDeleting}
                onClick={confirmDelete}
              >
                Delete
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
