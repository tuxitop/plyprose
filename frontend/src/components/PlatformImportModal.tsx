import { useEffect, useState } from 'react';
import {
  Download,
  AlertCircle,
  Calendar,
  ShieldCheck,
  CheckSquare,
  Square,
  RefreshCw,
} from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { fetchPlatformGames, getSettings, importBatchGames } from '../lib/api';
import type { BatchImportGameItem, PlatformPreviewGame, Settings, SyncTimeRange } from '../types';

interface PlatformImportModalProps {
  open: boolean;
  onClose: () => void;
  onImportDone: () => void;
}

export function PlatformImportModal({ open, onClose, onImportDone }: PlatformImportModalProps) {
  const [platform, setPlatform] = useState<'lichess' | 'chesscom'>('chesscom');
  const [timeRange, setTimeRange] = useState<SyncTimeRange>('1w');
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);

  const [fetching, setFetching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [games, setGames] = useState<PlatformPreviewGame[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hasFetched, setHasFetched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    void Promise.resolve().then(() => {
      if (ignore) return;
      setError(null);
      setSuccessMsg(null);
      setHasFetched(false);
      setGames([]);
      setSelectedIds(new Set());
      getSettings().then(s => {
        if (ignore) return;
        setSettings(s);
        if (s.chesscom_username && !s.lichess_username) {
          setPlatform('chesscom');
        } else if (s.lichess_username && !s.chesscom_username) {
          setPlatform('lichess');
        }
      });
    });
    return () => {
      ignore = true;
    };
  }, [open]);

  if (!open) return null;

  const chesscomUser = settings?.chesscom_username?.trim();
  const lichessUser = settings?.lichess_username?.trim();
  const currentUsername = platform === 'chesscom' ? chesscomUser : lichessUser;

  const handleFetch = async () => {
    if (!currentUsername) {
      setError(
        `Please configure your ${platform === 'chesscom' ? 'Chess.com' : 'Lichess'} username in Settings first.`,
      );
      return;
    }

    if (timeRange === 'custom' && !sinceDate) {
      setError('Please specify a start date for the custom range.');
      return;
    }

    setError(null);
    setSuccessMsg(null);
    setFetching(true);

    try {
      const res = await fetchPlatformGames({
        platform,
        timeRange,
        since: timeRange === 'custom' ? sinceDate : undefined,
        until: timeRange === 'custom' ? untilDate : undefined,
        maxGames: 100,
      });

      setGames(res.games);
      setHasFetched(true);

      // By default, pre-select all games that aren't already imported
      const newIds = new Set<string>();
      for (const g of res.games) {
        if (!g.already_imported) {
          newIds.add(g.id);
        }
      }
      setSelectedIds(newIds);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch games.');
    } finally {
      setFetching(false);
    }
  };

  const toggleSelectGame = (id: string, disabled: boolean) => {
    if (disabled) return;
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAllNew = () => {
    const next = new Set<string>();
    for (const g of games) {
      if (!g.already_imported) {
        next.add(g.id);
      }
    }
    setSelectedIds(next);
  };

  const handleDeselectAll = () => {
    setSelectedIds(new Set());
  };

  const handleImportSelected = async () => {
    const toImport = games.filter(g => selectedIds.has(g.id));
    if (toImport.length === 0) return;

    setImporting(true);
    setError(null);

    try {
      const batchPayload: BatchImportGameItem[] = toImport.map(g => ({
        pgn: g.pgn,
        platform: g.platform || platform,
        external_id: g.id,
        white: g.white,
        black: g.black,
        result: g.result,
        time_control: g.time_control,
        date: g.date,
        played_at: g.played_at,
        side: g.side,
      }));

      const res = await importBatchGames(batchPayload);
      setSuccessMsg(
        `Successfully imported ${res.imported_count} game${res.imported_count === 1 ? '' : 's'} into your library!`,
      );
      onImportDone();

      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const timeOptions: { id: SyncTimeRange; label: string }[] = [
    { id: '1d', label: '1 Day' },
    { id: '1w', label: '1 Week' },
    { id: '1month', label: '1 Month' },
    { id: 'custom', label: 'Custom' },
  ];

  const newGamesCount = games.filter(g => !g.already_imported).length;

  return (
    <Modal open={open} onClose={onClose} title="Import Games from Platform" width="max-w-3xl">
      <div className="flex flex-col gap-4 text-sm">
        {/* Top Controls: Platform & Time Range */}
        <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/60 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Platform Selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Platform:
              </span>
              <div className="inline-flex p-0.5 rounded-lg bg-slate-200 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                {(['chesscom', 'lichess'] as const).map(p => {
                  const active = platform === p;
                  const uname = p === 'chesscom' ? chesscomUser : lichessUser;
                  const label = p === 'chesscom' ? 'Chess.com' : 'Lichess';
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setPlatform(p);
                        setHasFetched(false);
                        setGames([]);
                        setSelectedIds(new Set());
                      }}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${
                        active
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-semibold shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      {label}
                      {uname && <span className="text-[10px] opacity-70 ml-1">({uname})</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Time Period Selector */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Period:
              </span>
              <div className="inline-flex p-0.5 rounded-lg bg-slate-200 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                {timeOptions.map(t => {
                  const active = timeRange === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setTimeRange(t.id);
                        setHasFetched(false);
                      }}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all cursor-pointer ${
                        active
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-semibold shadow-sm'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                      }`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Fetch Button */}
            <Button
              variant="primary"
              size="sm"
              loading={fetching}
              icon={<RefreshCw size={12} />}
              onClick={handleFetch}
            >
              Fetch Games
            </Button>
          </div>

          {/* Custom Date Pickers */}
          {timeRange === 'custom' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-200/80 dark:border-slate-800/80">
              <Input
                label="From (Start Date)"
                type="date"
                value={sinceDate}
                onChange={e => setSinceDate(e.target.value)}
              />
              <Input
                label="To (End Date - optional)"
                type="date"
                value={untilDate}
                onChange={e => setUntilDate(e.target.value)}
              />
            </div>
          )}

          {!currentUsername && (
            <div className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <AlertCircle size={13} />
              <span>
                {platform === 'chesscom' ? 'Chess.com' : 'Lichess'} username is not configured in
                Settings.
              </span>
            </div>
          )}
        </div>

        {/* Feedback message */}
        {error && (
          <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle size={14} className="shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 text-xs flex items-center gap-2">
            <ShieldCheck size={14} className="shrink-0 text-emerald-500" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Game List Area */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 flex flex-col">
          {/* List Header / Selection bar */}
          <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-800 dark:text-slate-200">
                {hasFetched ? `${games.length} games found` : 'Games List'}
              </span>
              {hasFetched && newGamesCount < games.length && (
                <span className="text-slate-400">
                  ({newGamesCount} new, {games.length - newGamesCount} already in library)
                </span>
              )}
            </div>

            {hasFetched && games.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={handleSelectAllNew}
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer"
                >
                  Select All New ({newGamesCount})
                </button>
                <span className="text-slate-300 dark:text-slate-700">|</span>
                <button
                  type="button"
                  onClick={handleDeselectAll}
                  className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 cursor-pointer"
                >
                  Deselect All
                </button>
              </div>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800/60">
            {!hasFetched && !fetching && (
              <div className="p-10 text-center text-slate-400 dark:text-slate-500 text-xs">
                Select your platform and time period above, then click <strong>Fetch Games</strong>{' '}
                to preview your games.
              </div>
            )}

            {fetching && (
              <div className="p-10 flex flex-col items-center justify-center gap-2 text-slate-400 dark:text-slate-500 text-xs">
                <RefreshCw size={18} className="animate-spin text-blue-500" />
                <span>
                  Fetching games from {platform === 'chesscom' ? 'Chess.com' : 'Lichess'}…
                </span>
              </div>
            )}

            {hasFetched && games.length === 0 && !fetching && (
              <div className="p-10 text-center text-slate-400 dark:text-slate-500 text-xs">
                No games found for this time period. Try selecting a broader time range.
              </div>
            )}

            {hasFetched &&
              games.map(game => {
                const isSelected = selectedIds.has(game.id);
                const disabled = game.already_imported;

                const outcomeClasses =
                  game.outcome === 'win'
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800'
                    : game.outcome === 'loss'
                      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300 border-rose-300 dark:border-rose-800'
                      : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700';

                return (
                  <div
                    key={game.id}
                    onClick={() => toggleSelectGame(game.id, disabled)}
                    className={`px-4 py-3 flex items-center justify-between gap-3 transition-colors ${
                      disabled
                        ? 'bg-slate-50/60 dark:bg-slate-900/40 opacity-60 cursor-not-allowed'
                        : isSelected
                          ? 'bg-blue-50/50 dark:bg-blue-950/20 hover:bg-blue-50/80 cursor-pointer'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer'
                    }`}
                  >
                    {/* Left: Checkbox & Opponent Details */}
                    <div className="flex items-center gap-3 min-w-0">
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={e => {
                          e.stopPropagation();
                          toggleSelectGame(game.id, disabled);
                        }}
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 shrink-0 cursor-pointer"
                      >
                        {disabled ? (
                          <Square size={16} className="text-slate-300 dark:text-slate-700" />
                        ) : isSelected ? (
                          <CheckSquare size={16} className="text-blue-600 dark:text-blue-400" />
                        ) : (
                          <Square size={16} />
                        )}
                      </button>

                      <div className="flex flex-col min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Platform Badge */}
                          <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded border bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700">
                            {platform === 'chesscom' ? 'Chess.com' : 'Lichess'}
                          </span>

                          {/* Player Side Badge */}
                          <span
                            className={`inline-flex items-center gap-1 text-[11px] font-semibold px-1.5 py-0.5 rounded border ${
                              game.side === 'white'
                                ? 'bg-white text-slate-800 border-slate-300 dark:bg-slate-200 dark:text-slate-900'
                                : 'bg-slate-900 text-white border-slate-900 dark:bg-slate-800 dark:text-slate-100'
                            }`}
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${game.side === 'white' ? 'bg-slate-200 border border-slate-400' : 'bg-slate-900 border border-slate-600'}`}
                            />
                            {game.side === 'white' ? 'White' : 'Black'}
                          </span>

                          {/* Opponent Name & Elo */}
                          <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                            vs {game.opponent}
                          </span>
                          {game.opponent_elo && (
                            <span className="text-[11px] font-mono text-slate-400">
                              ({game.opponent_elo})
                            </span>
                          )}

                          {/* Status Note */}
                          {game.already_analyzed && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 font-medium">
                              Analyzed
                            </span>
                          )}
                          {game.already_pending && !game.already_analyzed && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800 font-medium">
                              In Library
                            </span>
                          )}
                        </div>

                        {/* Played At */}
                        <span className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 flex items-center gap-1">
                          <Calendar size={11} />
                          {game.played_at || game.date || 'Unknown date'}
                        </span>
                      </div>
                    </div>

                    {/* Right: Time Control & Result */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1">
                        <span>{game.speed_icon}</span>
                        <span className="font-medium">{game.speed_label}</span>
                        <span className="text-[11px] text-slate-400">({game.time_control})</span>
                      </span>

                      <span
                        className={`text-[11px] font-bold px-2 py-0.5 rounded border capitalize ${outcomeClasses}`}
                      >
                        {game.outcome} ({game.result})
                      </span>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800 flex-wrap gap-2">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {selectedIds.size > 0 ? (
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {selectedIds.size} game{selectedIds.size === 1 ? '' : 's'} selected for import
              </span>
            ) : (
              <span>Select games to import into your library</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={importing}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Download size={13} />}
              loading={importing}
              disabled={selectedIds.size === 0}
              onClick={handleImportSelected}
            >
              Import Selected ({selectedIds.size})
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
