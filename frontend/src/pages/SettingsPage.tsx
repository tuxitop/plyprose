import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Sparkles,
  RefreshCw,
  Zap,
  Clock,
  Eye,
  EyeOff,
  Github,
} from 'lucide-react';
import { Button } from '../components/Button';
import { Input, Textarea } from '../components/Input';
import {
  getDetectedRatings,
  getSettings,
  listModels,
  syncAllToGitHub,
  testConnection,
  testGitHubConnection,
  updateSettings,
  verifyUsername,
} from '../lib/api';
import type { DetectedRatingsResponse, Settings } from '../types';

interface SettingsPageProps {
  onBack: () => void;
}

const ELO_LABELS = [
  { max: 999, label: 'Beginner' },
  { max: 1199, label: 'Novice' },
  { max: 1599, label: 'Intermediate' },
  { max: 1999, label: 'Club Player' },
  { max: 2199, label: 'Advanced' },
  { max: 9999, label: 'Expert / Master' },
];

function eloLabel(elo?: number): string {
  if (!elo) return 'Intermediate';
  return ELO_LABELS.find(l => elo <= l.max)?.label ?? 'Expert / Master';
}

interface StatusPill {
  ok: boolean | null;
  message: string;
}

export function SettingsPage({ onBack }: SettingsPageProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [connStatus, setConnStatus] = useState<StatusPill>({ ok: null, message: '' });
  const [testingConn, setTestingConn] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [verifyStatus, setVerifyStatus] = useState<Record<string, StatusPill>>({});
  const [detectedRatings, setDetectedRatings] = useState<DetectedRatingsResponse | null>(null);
  const [detectingRatings, setDetectingRatings] = useState(false);
  const [showGhToken, setShowGhToken] = useState(false);
  const [ghConnStatus, setGhConnStatus] = useState<StatusPill>({ ok: null, message: '' });
  const [testingGhConn, setTestingGhConn] = useState(false);
  const [syncingAllGh, setSyncingAllGh] = useState(false);
  const [syncAllResult, setSyncAllResult] = useState<StatusPill>({ ok: null, message: '' });

  const providers = ['openai-compat', 'gemini'];

  const loadDetectedRatings = async () => {
    setDetectingRatings(true);
    try {
      const res = await getDetectedRatings();
      setDetectedRatings(res);
    } catch (e) {
      console.error('Failed to load detected ratings:', e);
    } finally {
      setDetectingRatings(false);
    }
  };

  useEffect(() => {
    let ignore = false;
    getSettings().then(s => {
      if (!ignore) setSettings(s);
    });
    void Promise.resolve().then(() => {
      if (!ignore) loadDetectedRatings();
    });
    return () => {
      ignore = true;
    };
  }, []);

  const baseUrl = settings?.llm_base_url;
  const apiKey = settings?.llm_api_key;
  const hasSettings = Boolean(settings);

  useEffect(() => {
    if (hasSettings) {
      listModels()
        .then(r => setModels(r.models))
        .catch(() => setModels([]));
    }
  }, [hasSettings, baseUrl, apiKey]);

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full p-12 text-slate-400 dark:text-slate-500 text-sm">
        Loading settings…
      </div>
    );
  }

  const update = (patch: Partial<Settings>) => setSettings(s => (s ? { ...s, ...patch } : s));

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    try {
      const savedData = await updateSettings(settings);
      setSettings(savedData);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!settings) return;
    await updateSettings({
      llm_provider: settings.llm_provider,
      llm_base_url: settings.llm_base_url,
      llm_api_key: settings.llm_api_key,
      llm_model: settings.llm_model,
    });
    setTestingConn(true);
    setConnStatus({ ok: null, message: 'Testing…' });
    try {
      const res = await testConnection();
      setConnStatus({ ok: res.ok, message: res.message });
      if (res.ok) {
        const m = await listModels();
        setModels(m.models);
      }
    } finally {
      setTestingConn(false);
    }
  };

  const handleVerify = async (plat: string, username: string) => {
    setVerifyStatus(s => ({ ...s, [plat]: { ok: null, message: 'Checking…' } }));
    const res = await verifyUsername(plat, username);
    setVerifyStatus(s => ({ ...s, [plat]: { ok: res.ok, message: res.message } }));
    if (res.ok) {
      loadDetectedRatings();
    }
  };

  const handleApplyAllDetected = () => {
    if (!detectedRatings?.suggestions) return;
    update(detectedRatings.suggestions);
  };

  const handleTestGitHubConnection = async () => {
    if (!settings) return;
    setTestingGhConn(true);
    setGhConnStatus({ ok: null, message: 'Testing GitHub connection…' });
    try {
      const res = await testGitHubConnection({
        token: settings.github_token,
        repo: settings.github_repo,
        branch: settings.github_branch || 'main',
      });
      setGhConnStatus({ ok: res.ok, message: res.message });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      setGhConnStatus({ ok: false, message: msg });
    } finally {
      setTestingGhConn(false);
    }
  };

  const handleSyncAllGitHub = async () => {
    if (!settings) return;
    setSyncingAllGh(true);
    setSyncAllResult({ ok: null, message: 'Syncing analyzed games to GitHub…' });
    try {
      await updateSettings(settings);
      const res = await syncAllToGitHub();
      if (res.ok) {
        const skippedText =
          (res.skipped_count ?? 0) > 0 ? ` (${res.skipped_count} already up to date)` : '';
        setSyncAllResult({
          ok: true,
          message:
            res.message ||
            `Synced ${res.synced_count} analyzed game${res.synced_count === 1 ? '' : 's'}${skippedText}!`,
        });
      } else {
        setSyncAllResult({
          ok: false,
          message: `Synced ${res.synced_count} game(s) with errors: ${res.errors?.join('; ') || res.message}`,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      setSyncAllResult({ ok: false, message: msg });
    } finally {
      setSyncingAllGh(false);
    }
  };

  const hasSuggestions =
    detectedRatings?.suggestions && Object.keys(detectedRatings.suggestions).length > 0;

  return (
    <div className="max-w-3xl mx-auto w-full p-6 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 flex items-center gap-1 text-sm transition-colors cursor-pointer"
          >
            <ArrowLeft size={14} />
            Back to Games
          </button>
          <span className="text-slate-300 dark:text-slate-700">|</span>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Settings</h1>
        </div>
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
              <CheckCircle size={12} /> Saved
            </span>
          )}
          <Button variant="primary" loading={saving} onClick={handleSave}>
            Save All Changes
          </Button>
        </div>
      </div>

      {/* Player Profile & Ratings */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
        <div className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 px-5 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Player Ratings & Platforms
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Blitz and Rapid ratings differ across platforms (Chess.com vs Lichess). The coach
              personalizes feedback to your exact rating level.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            loading={detectingRatings}
            icon={<RefreshCw size={12} />}
            onClick={loadDetectedRatings}
          >
            Detect from Games
          </Button>
        </div>

        <div className="p-5 flex flex-col gap-5">
          {/* Detected Ratings Notification / Card */}
          {hasSuggestions && (
            <div className="p-4 rounded-xl bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-900/50 flex flex-col gap-2.5">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-900 dark:text-blue-200">
                  <Sparkles size={14} className="text-blue-500" />
                  <span>Ratings detected from your games PGN & profiles</span>
                </div>
                <Button variant="secondary" size="sm" onClick={handleApplyAllDetected}>
                  Apply All Detected
                </Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                {detectedRatings?.pgn_ratings?.chesscom_blitz && (
                  <div className="flex items-center justify-between bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-blue-100 dark:border-blue-900/60">
                    <div>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Chess.com Blitz:{' '}
                      </span>
                      <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                        {detectedRatings.pgn_ratings.chesscom_blitz.rating}
                      </span>
                      {detectedRatings.pgn_ratings.chesscom_blitz.played_at && (
                        <span className="text-[10px] text-slate-400 block">
                          {detectedRatings.pgn_ratings.chesscom_blitz.played_at.slice(0, 10)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        update({
                          elo_chesscom_blitz: detectedRatings.pgn_ratings.chesscom_blitz.rating,
                        })
                      }
                      className="text-[11px] font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
                    >
                      Use
                    </button>
                  </div>
                )}

                {detectedRatings?.pgn_ratings?.chesscom_rapid && (
                  <div className="flex items-center justify-between bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-blue-100 dark:border-blue-900/60">
                    <div>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Chess.com Rapid:{' '}
                      </span>
                      <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                        {detectedRatings.pgn_ratings.chesscom_rapid.rating}
                      </span>
                      {detectedRatings.pgn_ratings.chesscom_rapid.played_at && (
                        <span className="text-[10px] text-slate-400 block">
                          {detectedRatings.pgn_ratings.chesscom_rapid.played_at.slice(0, 10)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        update({
                          elo_chesscom_rapid: detectedRatings.pgn_ratings.chesscom_rapid.rating,
                        })
                      }
                      className="text-[11px] font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
                    >
                      Use
                    </button>
                  </div>
                )}

                {detectedRatings?.pgn_ratings?.lichess_blitz && (
                  <div className="flex items-center justify-between bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-blue-100 dark:border-blue-900/60">
                    <div>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Lichess Blitz:{' '}
                      </span>
                      <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                        {detectedRatings.pgn_ratings.lichess_blitz.rating}
                      </span>
                      {detectedRatings.pgn_ratings.lichess_blitz.played_at && (
                        <span className="text-[10px] text-slate-400 block">
                          {detectedRatings.pgn_ratings.lichess_blitz.played_at.slice(0, 10)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        update({
                          elo_lichess_blitz: detectedRatings.pgn_ratings.lichess_blitz.rating,
                        })
                      }
                      className="text-[11px] font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
                    >
                      Use
                    </button>
                  </div>
                )}

                {detectedRatings?.pgn_ratings?.lichess_rapid && (
                  <div className="flex items-center justify-between bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-blue-100 dark:border-blue-900/60">
                    <div>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        Lichess Rapid:{' '}
                      </span>
                      <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                        {detectedRatings.pgn_ratings.lichess_rapid.rating}
                      </span>
                      {detectedRatings.pgn_ratings.lichess_rapid.played_at && (
                        <span className="text-[10px] text-slate-400 block">
                          {detectedRatings.pgn_ratings.lichess_rapid.played_at.slice(0, 10)}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        update({
                          elo_lichess_rapid: detectedRatings.pgn_ratings.lichess_rapid.rating,
                        })
                      }
                      className="text-[11px] font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
                    >
                      Use
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Platform 1: Chess.com */}
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                Chess.com Profile & Ratings
              </span>
            </div>

            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Input
                  label="Chess.com Username"
                  value={settings.chesscom_username}
                  onChange={e => update({ chesscom_username: e.target.value })}
                  placeholder="e.g. hikaru"
                />
              </div>
              <div className="pt-5 flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!settings.chesscom_username.trim()}
                  onClick={() => handleVerify('chesscom', settings.chesscom_username)}
                >
                  Verify
                </Button>
                {verifyStatus.chesscom?.ok !== null &&
                  verifyStatus.chesscom?.ok !== undefined &&
                  (verifyStatus.chesscom.ok ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <XCircle size={14} className="text-rose-500" />
                  ))}
                {verifyStatus.chesscom?.message && (
                  <span
                    className={`text-[10px] ${verifyStatus.chesscom.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                  >
                    {verifyStatus.chesscom.message}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <Input
                  id="chesscom-blitz-rating"
                  label="Blitz Rating (ELO)"
                  type="number"
                  min={100}
                  max={3500}
                  value={settings.elo_chesscom_blitz ?? 1200}
                  onChange={e => update({ elo_chesscom_blitz: Number(e.target.value) })}
                  placeholder="e.g. 1400"
                />
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <Zap size={11} className="text-amber-500" />
                  Auto-label:{' '}
                  <strong className="text-slate-700 dark:text-slate-300">
                    {eloLabel(settings.elo_chesscom_blitz ?? 1200)}
                  </strong>
                </p>
              </div>

              <div>
                <Input
                  id="chesscom-rapid-rating"
                  label="Rapid Rating (ELO)"
                  type="number"
                  min={100}
                  max={3500}
                  value={settings.elo_chesscom_rapid ?? 1200}
                  onChange={e => update({ elo_chesscom_rapid: Number(e.target.value) })}
                  placeholder="e.g. 1550"
                />
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <Clock size={11} className="text-blue-500" />
                  Auto-label:{' '}
                  <strong className="text-slate-700 dark:text-slate-300">
                    {eloLabel(settings.elo_chesscom_rapid ?? 1200)}
                  </strong>
                </p>
              </div>
            </div>
          </div>

          {/* Platform 2: Lichess */}
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                Lichess Profile & Ratings
              </span>
            </div>

            <div className="flex items-start gap-2">
              <div className="flex-1">
                <Input
                  id="lichess-username"
                  label="Lichess Username"
                  value={settings.lichess_username}
                  onChange={e => update({ lichess_username: e.target.value })}
                  placeholder="e.g. DrNykterstein"
                />
              </div>
              <div className="pt-5 flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!settings.lichess_username.trim()}
                  onClick={() => handleVerify('lichess', settings.lichess_username)}
                >
                  Verify
                </Button>
                {verifyStatus.lichess?.ok !== null &&
                  verifyStatus.lichess?.ok !== undefined &&
                  (verifyStatus.lichess.ok ? (
                    <CheckCircle size={14} className="text-emerald-500" />
                  ) : (
                    <XCircle size={14} className="text-rose-500" />
                  ))}
                {verifyStatus.lichess?.message && (
                  <span
                    className={`text-[10px] ${verifyStatus.lichess.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                  >
                    {verifyStatus.lichess.message}
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <Input
                  id="lichess-blitz-rating"
                  label="Blitz Rating (ELO)"
                  type="number"
                  min={100}
                  max={3500}
                  value={settings.elo_lichess_blitz ?? 1500}
                  onChange={e => update({ elo_lichess_blitz: Number(e.target.value) })}
                  placeholder="e.g. 1650"
                />
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <Zap size={11} className="text-amber-500" />
                  Auto-label:{' '}
                  <strong className="text-slate-700 dark:text-slate-300">
                    {eloLabel(settings.elo_lichess_blitz ?? 1500)}
                  </strong>
                </p>
              </div>

              <div>
                <Input
                  id="lichess-rapid-rating"
                  label="Rapid Rating (ELO)"
                  type="number"
                  min={100}
                  max={3500}
                  value={settings.elo_lichess_rapid ?? 1600}
                  onChange={e => update({ elo_lichess_rapid: Number(e.target.value) })}
                  placeholder="e.g. 1750"
                />
                <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                  <Clock size={11} className="text-blue-500" />
                  Auto-label:{' '}
                  <strong className="text-slate-700 dark:text-slate-300">
                    {eloLabel(settings.elo_lichess_rapid ?? 1600)}
                  </strong>
                </p>
              </div>
            </div>
          </div>

          {/* General / Fallback Rating */}
          <div className="grid grid-cols-1 gap-2">
            <div>
              <Input
                label="Fallback / General ELO"
                type="number"
                min={100}
                max={3500}
                value={settings.elo}
                onChange={e => update({ elo: Number(e.target.value) })}
                placeholder="e.g. 1400"
              />
              <p className="text-[11px] text-slate-400 mt-1">
                Used for manual imports or games where platform and time control are unclassified:{' '}
                <strong className="text-slate-700 dark:text-slate-300">
                  {eloLabel(settings.elo)}
                </strong>{' '}
                ({settings.elo} ELO)
              </p>
            </div>
          </div>

          {/* Improvement Goals */}
          <Textarea
            label="Improvement Goals"
            rows={3}
            value={settings.goals}
            onChange={e => update({ goals: e.target.value })}
            placeholder="e.g. Stop hanging pieces in time trouble, improve endgame conversion, punish early queen attacks"
            hint="Passed to the LLM as [OPTIONAL GOALS]. Be specific — it improves coaching quality."
          />
        </div>
      </section>

      {/* Stockfish Engine */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
        <div className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Stockfish Engine
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Analysis halts when <strong>either</strong> threshold is reached first.
          </p>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="stockfish-depth-range"
                className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-2 cursor-pointer"
              >
                Search Depth{' '}
                <span className="text-slate-400 dark:text-slate-500 font-normal">(10–25)</span>
              </label>
              <input
                id="stockfish-depth-range"
                type="range"
                min={10}
                max={25}
                step={1}
                value={settings.stockfish_depth}
                onChange={e => update({ stockfish_depth: Number(e.target.value) })}
                className="w-full accent-slate-800 dark:accent-slate-200"
              />
              <div className="flex justify-between text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                <span>10</span>
                <span className="font-semibold text-slate-700 dark:text-slate-300 text-xs">
                  {settings.stockfish_depth}
                </span>
                <span>25</span>
              </div>
            </div>
            <div>
              <label
                htmlFor="stockfish-time-range"
                className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-2 cursor-pointer"
              >
                Time per Move{' '}
                <span className="text-slate-400 dark:text-slate-500 font-normal">(sec)</span>
              </label>
              <input
                id="stockfish-time-range"
                type="range"
                min={0.05}
                max={2.0}
                step={0.05}
                value={settings.stockfish_time}
                onChange={e => update({ stockfish_time: Number(e.target.value) })}
                className="w-full accent-slate-800 dark:accent-slate-200"
              />
              <div className="flex justify-between text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
                <span>0.05s</span>
                <span className="font-semibold text-slate-700 dark:text-slate-300 text-xs">
                  {settings.stockfish_time.toFixed(2)}s
                </span>
                <span>2.0s</span>
              </div>
            </div>
          </div>

          <Input
            label="Stockfish Binary Path"
            value={settings.stockfish_path}
            onChange={e => update({ stockfish_path: e.target.value })}
            placeholder="/usr/sbin/stockfish"
            hint="Absolute path to the Stockfish executable on this machine."
          />
        </div>
      </section>

      {/* LLM Provider */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
        <div className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">LLM Provider</h2>
        </div>
        <div className="p-5 flex flex-col gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-1.5">
              Provider
            </span>
            <div className="flex gap-2">
              {providers.map(p => (
                <button
                  key={p}
                  onClick={() => update({ llm_provider: p })}
                  className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors cursor-pointer
                    ${
                      settings.llm_provider === p
                        ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-500'
                    }`}
                >
                  {p === 'openai-compat' ? 'OpenAI-Compatible' : 'Google Gemini'}
                </button>
              ))}
            </div>
          </div>

          <Input
            label="Base URL"
            value={settings.llm_base_url}
            onChange={e => update({ llm_base_url: e.target.value })}
            placeholder="http://localhost:11434/v1"
            hint="Endpoint exposing /chat/completions. Works with Ollama, LM Studio, OpenAI, OpenRouter, etc."
          />

          <Input
            label="API Key"
            type={showKey ? 'text' : 'password'}
            value={settings.llm_api_key}
            onChange={e => update({ llm_api_key: e.target.value })}
            placeholder="sk-… or leave empty for local servers"
            rightElement={
              <button
                type="button"
                onClick={() => setShowKey(v => !v)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-0.5 cursor-pointer"
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
          />

          <div>
            <Input
              label="Model Name"
              value={settings.llm_model}
              onChange={e => update({ llm_model: e.target.value })}
              placeholder="gpt-4o, deepseek-r1, claude-3-5-sonnet, …"
            />
            {models.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {models.slice(0, 8).map(m => (
                  <button
                    key={m}
                    onClick={() => update({ llm_model: m })}
                    className={`px-2 py-0.5 rounded text-[10px] border transition-colors font-mono cursor-pointer
                      ${
                        settings.llm_model === m
                          ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-200 dark:text-slate-900 dark:border-slate-200'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-500'
                      }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button variant="secondary" loading={testingConn} onClick={handleTestConnection}>
              🧪 Test Connection
            </Button>
            {connStatus.ok !== null && (
              <span
                className={`text-xs flex items-center gap-1 ${connStatus.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
              >
                {connStatus.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                {connStatus.message}
              </span>
            )}
            {connStatus.ok === null && connStatus.message && (
              <span className="text-xs text-slate-400 dark:text-slate-500">
                {connStatus.message}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* GitHub Repository Sync */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
        <div className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Github size={18} className="text-slate-700 dark:text-slate-300" />
            <div>
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                GitHub Repository Sync
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Sync AI-analyzed games as Markdown, SVG diagrams, PDF, and PGN into your repository.
              </p>
            </div>
          </div>
          <label
            htmlFor="github-sync-enabled"
            className="flex items-center gap-2 cursor-pointer select-none"
          >
            <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
              Enable Sync
            </span>
            <input
              id="github-sync-enabled"
              type="checkbox"
              checked={!!settings.github_enabled}
              onChange={e => update({ github_enabled: e.target.checked })}
              className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300 dark:border-slate-700 dark:bg-slate-800 cursor-pointer"
            />
          </label>
        </div>

        <div className="p-5 flex flex-col gap-4">
          <div className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400 flex flex-col gap-1.5">
            <div className="font-medium text-slate-800 dark:text-slate-200">
              Standard Folder Hierarchy:
            </div>
            <code className="font-mono text-[11px] bg-white dark:bg-slate-900 px-2 py-1 rounded border border-slate-200 dark:border-slate-800 text-blue-600 dark:text-blue-400 break-all">
              [PLATFORM]/[SPEED]/[YEAR]-[MONTH]/[DAY]-[TIME]-[WHITE]-[BLACK]-[RESULT]/
            </code>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Example:{' '}
              <code className="font-mono text-slate-700 dark:text-slate-300">
                chess.com/blitz/2026-10/25-0930-tuxitop-keswic-white/
              </code>
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              Contains <strong className="text-slate-700 dark:text-slate-300">report.md</strong>{' '}
              (with inline diagrams rendered natively on GitHub),{' '}
              <strong className="text-slate-700 dark:text-slate-300">report.pdf</strong>,{' '}
              <strong className="text-slate-700 dark:text-slate-300">game.pgn</strong>, and{' '}
              <strong className="text-slate-700 dark:text-slate-300">assets/*.svg</strong>. Only
              games analyzed by AI are pushed. Deleting an analyzed game also removes it from
              GitHub.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <Input
                label="GitHub Repository"
                value={settings.github_repo ?? ''}
                onChange={e => update({ github_repo: e.target.value })}
                placeholder="owner/repo (e.g. your-username/chess-notes)"
                hint="Target GitHub repository in 'owner/repo' format."
              />
            </div>
            <div>
              <Input
                label="Target Branch"
                value={settings.github_branch ?? 'main'}
                onChange={e => update({ github_branch: e.target.value })}
                placeholder="main"
                hint="Branch name (default: main)."
              />
            </div>
          </div>

          <Input
            label="Personal Access Token (PAT)"
            type={showGhToken ? 'text' : 'password'}
            value={settings.github_token ?? ''}
            onChange={e => update({ github_token: e.target.value })}
            placeholder="ghp_… or github_pat_…"
            hint="Requires 'Contents: Read and write' permission (or classic token with 'repo' scope)."
            rightElement={
              <button
                type="button"
                onClick={() => setShowGhToken(v => !v)}
                className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-0.5 cursor-pointer"
                aria-label={showGhToken ? 'Hide GitHub token' : 'Show GitHub token'}
              >
                {showGhToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            }
          />

          <div className="flex items-center justify-between flex-wrap gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="secondary"
                size="sm"
                loading={testingGhConn}
                onClick={handleTestGitHubConnection}
              >
                🧪 Test Connection
              </Button>
              {ghConnStatus.ok !== null && (
                <span
                  className={`text-xs flex items-center gap-1 ${ghConnStatus.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                >
                  {ghConnStatus.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                  {ghConnStatus.message}
                </span>
              )}
              {ghConnStatus.ok === null && ghConnStatus.message && (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  {ghConnStatus.message}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <Button
                variant="ghost"
                size="sm"
                loading={syncingAllGh}
                disabled={!settings.github_token || !settings.github_repo}
                icon={<RefreshCw size={12} />}
                onClick={handleSyncAllGitHub}
              >
                Sync All Analyzed Games Now
              </Button>
              {syncAllResult.ok !== null && (
                <span
                  className={`text-xs flex items-center gap-1 ${syncAllResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                >
                  {syncAllResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                  {syncAllResult.message}
                </span>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="flex justify-end pb-6">
        <Button variant="primary" loading={saving} onClick={handleSave} size="lg">
          Save All Changes
        </Button>
      </div>
    </div>
  );
}
