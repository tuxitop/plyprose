import { useEffect, useState } from 'react';
import { RefreshCw, CheckCircle, AlertCircle, Calendar, ShieldCheck } from 'lucide-react';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { getSettings, syncGames } from '../lib/api';
import type { Settings, SyncOptions, SyncTimeRange } from '../types';

interface SyncModalProps {
  open: boolean;
  onClose: () => void;
  onSynced: () => void;
}

export function SyncModal({ open, onClose, onSynced }: SyncModalProps) {
  const [platform, setPlatform] = useState<'lichess' | 'chesscom' | 'all'>('chesscom');
  const [timeRange, setTimeRange] = useState<SyncTimeRange>('1w');
  const [sinceDate, setSinceDate] = useState('');
  const [untilDate, setUntilDate] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let ignore = false;
    void Promise.resolve().then(() => {
      if (ignore) return;
      setError(null);
      setSuccessMsg(null);
      getSettings().then(s => {
        if (ignore) return;
        setSettings(s);
        // Default to a configured platform if available
        if (s.chesscom_username && !s.lichess_username) {
          setPlatform('chesscom');
        } else if (s.lichess_username && !s.chesscom_username) {
          setPlatform('lichess');
        } else if (s.chesscom_username && s.lichess_username) {
          setPlatform('all');
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

  const handleSync = async () => {
    setError(null);
    setSuccessMsg(null);
    setLoading(true);

    try {
      const opts: SyncOptions = {
        platform,
        timeRange,
        maxGames: 100,
      };
      if (timeRange === 'custom') {
        if (!sinceDate) {
          setError('Please specify a start date for custom syncing.');
          setLoading(false);
          return;
        }
        opts.since = sinceDate;
        if (untilDate) opts.until = untilDate;
      }

      const res = await syncGames(opts);
      onSynced();

      if (res.count > 0) {
        setSuccessMsg(`Successfully synced ${res.count} new game${res.count > 1 ? 's' : ''}!`);
        setTimeout(() => {
          onClose();
        }, 1200);
      } else {
        setSuccessMsg('Sync complete: No new games found for this time period.');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setLoading(false);
    }
  };

  const timeOptions: { id: SyncTimeRange; label: string; sub: string }[] = [
    { id: '1d', label: '1 Day', sub: 'Past 24 hours' },
    { id: '1w', label: '1 Week', sub: 'Past 7 days' },
    { id: '1month', label: '1 Month', sub: 'Past 30 days' },
    { id: 'custom', label: 'Custom', sub: 'Date range' },
  ];

  return (
    <Modal open={open} onClose={onClose} title="Sync Games from Platform" width="max-w-md">
      <div className="flex flex-col gap-5 text-sm">
        {/* Platform Selection */}
        <div>
          <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
            Select Platform
          </span>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                { id: 'chesscom', label: 'Chess.com', user: chesscomUser },
                { id: 'lichess', label: 'Lichess', user: lichessUser },
                {
                  id: 'all',
                  label: 'All Platforms',
                  user: chesscomUser || lichessUser ? 'Both' : undefined,
                },
              ] as const
            ).map(p => {
              const active = platform === p.id;
              const hasConfig = Boolean(p.user);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPlatform(p.id)}
                  className={`flex flex-col items-center justify-center p-3 rounded-lg border text-center transition-all cursor-pointer ${
                    active
                      ? 'border-blue-600 bg-blue-50/70 text-blue-900 dark:bg-blue-950/40 dark:border-blue-500 dark:text-blue-100 font-semibold shadow-sm'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <span className="text-sm">{p.label}</span>
                  <span className="text-[11px] mt-0.5 truncate max-w-full text-slate-400 dark:text-slate-500">
                    {hasConfig ? p.user : 'Not set'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Account status note */}
          <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            {platform === 'chesscom' &&
              (chesscomUser ? (
                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <ShieldCheck size={13} /> Connected as <strong>{chesscomUser}</strong>
                </span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertCircle size={13} /> Chess.com username not configured in Settings.
                </span>
              ))}
            {platform === 'lichess' &&
              (lichessUser ? (
                <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
                  <ShieldCheck size={13} /> Connected as <strong>{lichessUser}</strong>
                </span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1">
                  <AlertCircle size={13} /> Lichess username not configured in Settings.
                </span>
              ))}
            {platform === 'all' && <span>Syncing games for both configured accounts.</span>}
          </div>
        </div>

        {/* Time Selection */}
        <div>
          <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
            Time Period
          </span>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {timeOptions.map(t => {
              const active = timeRange === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTimeRange(t.id)}
                  className={`px-3 py-2.5 rounded-lg border text-center transition-all cursor-pointer flex flex-col items-center justify-center ${
                    active
                      ? 'border-slate-900 bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 font-medium shadow-sm'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <span className="text-sm font-semibold">{t.label}</span>
                  <span
                    className={`text-[10px] mt-0.5 ${active ? 'text-slate-200 dark:text-slate-700' : 'text-slate-400 dark:text-slate-500'}`}
                  >
                    {t.sub}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Custom Date Picker Inputs */}
          {timeRange === 'custom' && (
            <div className="mt-3.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex flex-col gap-2.5">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                <Calendar size={13} className="text-slate-400" />
                <span>Specify Custom Date Range</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
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
            </div>
          )}
        </div>

        {/* Feedback messages */}
        {error && (
          <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 text-xs flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 text-xs flex items-start gap-2">
            <CheckCircle size={14} className="shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<RefreshCw size={13} />}
            loading={loading}
            onClick={handleSync}
          >
            Start Sync
          </Button>
        </div>
      </div>
    </Modal>
  );
}
