import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle,
  XCircle,
  Sparkles,
  RefreshCw,
  Zap,
  Clock,
  Download,
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
  pullFromGitHub,
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
  const [pullingGh, setPullingGh] = useState(false);
  const [pullResult, setPullResult] = useState<StatusPill>({ ok: null, message: '' });

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
  const provider = settings?.llm_provider;
  const hasSettings = Boolean(settings);

  useEffect(() => {
    if (hasSettings) {
      listModels(provider, baseUrl, apiKey)
        .then(r => setModels(r.models))
        .catch(() => setModels([]));
    }
  }, [hasSettings, baseUrl, apiKey, provider]);

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
      gemini_api_key: settings.gemini_api_key,
      gemini_model: settings.gemini_model,
      openai_base_url: settings.openai_base_url,
      openai_api_key: settings.openai_api_key,
      openai_model: settings.openai_model,
    });
    setTestingConn(true);
    setConnStatus({ ok: null, message: 'Testing…' });
    try {
      const res = await testConnection();
      setConnStatus({ ok: res.ok, message: res.message });
      if (res.ok) {
        const m = await listModels(
          settings.llm_provider,
          settings.llm_base_url,
          settings.llm_api_key,
        );
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

  const handlePullGitHub = async () => {
    if (!settings) return;
    setPullingGh(true);
    setPullResult({ ok: null, message: 'Pulling analyzed games from GitHub…' });
    try {
      await updateSettings(settings);
      const res = await pullFromGitHub();
      if (res.ok) {
        setPullResult({
          ok: true,
          message: res.message || `Successfully pulled from GitHub!`,
        });
      } else {
        setPullResult({
          ok: false,
          message: `Pull failed: ${res.errors?.join('; ') || res.message}`,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Pull failed';
      setPullResult({ ok: false, message: msg });
    } finally {
      setPullingGh(false);
    }
  };

  const pgnRatings = detectedRatings?.pgn_ratings ?? {};
  const liveRatings = detectedRatings?.live_ratings ?? {};
  const suggestions = detectedRatings?.suggestions ?? {};

  const detectedRatingCards = [
    {
      key: 'chesscom_blitz',
      settingKey: 'elo_chesscom_blitz' as const,
      label: 'Chess.com Blitz',
      rating:
        suggestions.elo_chesscom_blitz ??
        liveRatings.chesscom_blitz ??
        pgnRatings.chesscom_blitz?.rating,
      date: pgnRatings.chesscom_blitz?.played_at,
      source: pgnRatings.chesscom_blitz
        ? 'PGN Games'
        : liveRatings.chesscom_blitz
          ? 'Live Profile'
          : undefined,
    },
    {
      key: 'chesscom_rapid',
      settingKey: 'elo_chesscom_rapid' as const,
      label: 'Chess.com Rapid',
      rating:
        suggestions.elo_chesscom_rapid ??
        liveRatings.chesscom_rapid ??
        pgnRatings.chesscom_rapid?.rating,
      date: pgnRatings.chesscom_rapid?.played_at,
      source: pgnRatings.chesscom_rapid
        ? 'PGN Games'
        : liveRatings.chesscom_rapid
          ? 'Live Profile'
          : undefined,
    },
    {
      key: 'lichess_blitz',
      settingKey: 'elo_lichess_blitz' as const,
      label: 'Lichess Blitz',
      rating:
        suggestions.elo_lichess_blitz ??
        liveRatings.lichess_blitz ??
        pgnRatings.lichess_blitz?.rating,
      date: pgnRatings.lichess_blitz?.played_at,
      source: pgnRatings.lichess_blitz
        ? 'PGN Games'
        : liveRatings.lichess_blitz
          ? 'Live Profile'
          : undefined,
    },
    {
      key: 'lichess_rapid',
      settingKey: 'elo_lichess_rapid' as const,
      label: 'Lichess Rapid',
      rating:
        suggestions.elo_lichess_rapid ??
        liveRatings.lichess_rapid ??
        pgnRatings.lichess_rapid?.rating,
      date: pgnRatings.lichess_rapid?.played_at,
      source: pgnRatings.lichess_rapid
        ? 'PGN Games'
        : liveRatings.lichess_rapid
          ? 'Live Profile'
          : undefined,
    },
  ].filter(c => typeof c.rating === 'number' && c.rating > 0);

  const hasSuggestions = detectedRatingCards.length > 0;

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
                {detectedRatingCards.map(c => {
                  const isApplied = settings[c.settingKey] === c.rating;
                  return (
                    <div
                      key={c.key}
                      className="flex items-center justify-between bg-white dark:bg-slate-900 px-3 py-2 rounded-lg border border-blue-100 dark:border-blue-900/60"
                    >
                      <div>
                        <span className="font-semibold text-slate-800 dark:text-slate-200">
                          {c.label}:{' '}
                        </span>
                        <span className="font-mono text-blue-600 dark:text-blue-400 font-bold">
                          {c.rating}
                        </span>
                        {c.date ? (
                          <span className="text-[10px] text-slate-400 block">
                            {c.date.slice(0, 10)} {c.source ? `(${c.source})` : ''}
                          </span>
                        ) : c.source ? (
                          <span className="text-[10px] text-slate-400 block">
                            Source: {c.source}
                          </span>
                        ) : null}
                      </div>
                      {isApplied ? (
                        <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1 bg-emerald-50 dark:bg-emerald-950/40 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-900">
                          <CheckCircle size={11} /> Applied
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => update({ [c.settingKey]: c.rating })}
                          className="text-[11px] font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 underline cursor-pointer"
                        >
                          Use
                        </button>
                      )}
                    </div>
                  );
                })}
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
      <section className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
        <div className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 px-5 py-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              Stockfish Engine
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Configure search depth, calculation time, and evaluation traversal order.
            </p>
          </div>
          {settings.stockfish_version ? (
            <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1 rounded-full flex items-center gap-1.5 shadow-sm">
              <CheckCircle size={12} className="text-emerald-500" />
              {settings.stockfish_version}
            </span>
          ) : (
            <span className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-2.5 py-1 rounded-full">
              Engine binary not detected
            </span>
          )}
        </div>
        <div className="p-5 flex flex-col gap-5">
          {/* Threshold Limit Mode */}
          <div>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 block mb-1.5">
              Evaluation Threshold Mode
            </span>
            <div className="flex flex-wrap gap-2">
              {[
                { id: 'both', label: 'Depth & Time (whichever reached first)' },
                { id: 'depth', label: 'Fixed Depth Only' },
                { id: 'time', label: 'Fixed Time Only' },
              ].map(mode => {
                const active = (settings.stockfish_limit_mode || 'both') === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() =>
                      update({
                        stockfish_limit_mode: mode.id as 'both' | 'depth' | 'time',
                      })
                    }
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 shadow-sm'
                        : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-500'
                    }`}
                  >
                    {mode.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div
              className={
                (settings.stockfish_limit_mode || 'both') === 'time'
                  ? 'opacity-40 pointer-events-none'
                  : ''
              }
            >
              <label
                htmlFor="stockfish-depth-range"
                className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-2 cursor-pointer"
              >
                Search Depth{' '}
                <span className="text-slate-400 dark:text-slate-500 font-normal">(10–25)</span>
                {(settings.stockfish_limit_mode || 'both') === 'time' && (
                  <span className="text-[10px] text-amber-500 ml-1.5 font-normal">
                    (Disabled in time-only mode)
                  </span>
                )}
              </label>
              <input
                id="stockfish-depth-range"
                type="range"
                min={10}
                max={25}
                step={1}
                disabled={(settings.stockfish_limit_mode || 'both') === 'time'}
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
            <div
              className={
                (settings.stockfish_limit_mode || 'both') === 'depth'
                  ? 'opacity-40 pointer-events-none'
                  : ''
              }
            >
              <label
                htmlFor="stockfish-time-range"
                className="text-sm font-medium text-slate-700 dark:text-slate-300 block mb-2 cursor-pointer"
              >
                Time per Move{' '}
                <span className="text-slate-400 dark:text-slate-500 font-normal">(sec)</span>
                {(settings.stockfish_limit_mode || 'both') === 'depth' && (
                  <span className="text-[10px] text-amber-500 ml-1.5 font-normal">
                    (Disabled in depth-only mode)
                  </span>
                )}
              </label>
              <input
                id="stockfish-time-range"
                type="range"
                min={0.05}
                max={2.0}
                step={0.05}
                disabled={(settings.stockfish_limit_mode || 'both') === 'depth'}
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

          {/* Backward Analysis Traversal */}
          <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
            <label
              htmlFor="stockfish-backward-analysis"
              className="flex items-start gap-3 cursor-pointer select-none"
            >
              <input
                id="stockfish-backward-analysis"
                type="checkbox"
                checked={settings.stockfish_backward_analysis ?? true}
                onChange={e => update({ stockfish_backward_analysis: e.target.checked })}
                className="mt-0.5 w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300 dark:border-slate-700 dark:bg-slate-800 cursor-pointer"
              />
              <div>
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-200 block">
                  Backward Analysis (Evaluate starting from end of game)
                </span>
                <span className="text-[11px] text-slate-500 dark:text-slate-400 block mt-0.5">
                  Evaluates moves in reverse (from final ply N down to starting position 0).
                  Populates the engine&apos;s transposition table with endgame knowledge,
                  eliminating horizon spikes and propagating forced mate depths backward (Lichess
                  fishnet standard).
                </span>
              </div>
            </label>
          </div>
        </div>
      </section>

      {/* LLM Provider */}
      <section className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm">
        <div className="bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">LLM Provider</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Configure your AI coaching model and credentials. All settings are stored securely in
            your local database.
          </p>
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
                  type="button"
                  onClick={() => {
                    if (p === 'gemini') {
                      update({
                        llm_provider: 'gemini',
                        llm_api_key: settings.gemini_api_key ?? settings.llm_api_key,
                        llm_model:
                          settings.gemini_model ??
                          (settings.llm_model.startsWith('gemini')
                            ? settings.llm_model
                            : 'gemini-2.5-flash'),
                      });
                    } else {
                      update({
                        llm_provider: 'openai-compat',
                        llm_base_url:
                          settings.openai_base_url ??
                          (settings.llm_base_url || 'http://localhost:11434/v1'),
                        llm_api_key: settings.openai_api_key ?? '',
                        llm_model:
                          settings.openai_model ??
                          (settings.llm_model.startsWith('gemini')
                            ? 'gpt-4o-mini'
                            : settings.llm_model),
                      });
                    }
                  }}
                  className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors cursor-pointer ${
                    settings.llm_provider === p
                      ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 shadow-sm'
                      : 'bg-white text-slate-700 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-500'
                  }`}
                >
                  {p === 'openai-compat' ? 'OpenAI-Compatible' : 'Google Gemini'}
                </button>
              ))}
            </div>
          </div>

          {settings.llm_provider === 'gemini' ? (
            <>
              <div className="p-3.5 rounded-lg bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/80 dark:border-blue-900/50 text-xs text-blue-900 dark:text-blue-200 flex items-start gap-2.5">
                <Sparkles size={15} className="text-blue-500 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-blue-950 dark:text-blue-100">
                    Direct Google GenAI Integration
                  </div>
                  <div className="text-[11px] text-blue-800/90 dark:text-blue-300 mt-0.5">
                    Google Gemini connects directly via the Google GenAI SDK. Base URL is not
                    required.
                  </div>
                </div>
              </div>

              <Input
                label="Google Gemini API Key"
                type={showKey ? 'text' : 'password'}
                value={settings.llm_api_key}
                onChange={e =>
                  update({
                    llm_api_key: e.target.value,
                    gemini_api_key: e.target.value,
                  })
                }
                placeholder="AIzaSy…"
                hint="Stored securely in your local settings database. Obtain a key from Google AI Studio (aistudio.google.com)."
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
                  label="Gemini Model Name"
                  value={settings.llm_model}
                  onChange={e =>
                    update({
                      llm_model: e.target.value,
                      gemini_model: e.target.value,
                    })
                  }
                  placeholder="gemini-2.5-flash, gemini-2.5-pro, gemini-3.8-flash, …"
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(models.filter(m => m.toLowerCase().includes('gemini')).length > 0
                    ? models.filter(m => m.toLowerCase().includes('gemini'))
                    : ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.7-flash']
                  )
                    .slice(0, 8)
                    .map(m => (
                      <button
                        key={m}
                        type="button"
                        onClick={() =>
                          update({
                            llm_model: m,
                            gemini_model: m,
                          })
                        }
                        className={`px-2 py-0.5 rounded text-[10px] border transition-colors font-mono cursor-pointer ${
                          settings.llm_model === m
                            ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-200 dark:text-slate-900 dark:border-slate-200'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-500'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <Input
                label="Base URL"
                value={settings.llm_base_url}
                onChange={e =>
                  update({
                    llm_base_url: e.target.value,
                    openai_base_url: e.target.value,
                  })
                }
                placeholder="http://localhost:11434/v1"
                hint="Endpoint exposing /chat/completions. Works with Ollama, LM Studio, OpenAI, OpenRouter, etc."
              />

              <Input
                label="API Key"
                type={showKey ? 'text' : 'password'}
                value={settings.llm_api_key}
                onChange={e =>
                  update({
                    llm_api_key: e.target.value,
                    openai_api_key: e.target.value,
                  })
                }
                placeholder="sk-… or leave empty for local servers"
                hint="Stored in local settings database. Not required for local Ollama / LM Studio instances."
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
                  onChange={e =>
                    update({
                      llm_model: e.target.value,
                      openai_model: e.target.value,
                    })
                  }
                  placeholder="gpt-4o, deepseek-r1, claude-3-5-sonnet, …"
                />
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {(models.filter(m => !m.toLowerCase().includes('gemini')).length > 0
                    ? models.filter(m => !m.toLowerCase().includes('gemini'))
                    : ['gpt-4o-mini', 'gpt-4o', 'deepseek-r1']
                  )
                    .slice(0, 8)
                    .map(m => (
                      <button
                        key={m}
                        type="button"
                        onClick={() =>
                          update({
                            llm_model: m,
                            openai_model: m,
                          })
                        }
                        className={`px-2 py-0.5 rounded text-[10px] border transition-colors font-mono cursor-pointer ${
                          settings.llm_model === m
                            ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-200 dark:text-slate-900 dark:border-slate-200'
                            : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 dark:hover:border-slate-500'
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                </div>
              </div>
            </>
          )}

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

          <div className="flex items-center justify-between p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60">
            <div>
              <div className="text-xs font-medium text-slate-800 dark:text-slate-200">
                Auto-Pull on Launch & Focus
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                Checks GitHub for new game analyses on launch or tab return (1 lightweight API
                check).
              </div>
            </div>
            <input
              id="github-auto-pull-enabled"
              type="checkbox"
              checked={settings.github_auto_pull !== false}
              onChange={e => update({ github_auto_pull: e.target.checked })}
              className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300 dark:border-slate-700 dark:bg-slate-800 cursor-pointer"
            />
          </div>

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
              {settings.github_last_synced_sha && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  Last synced commit:{' '}
                  <code className="font-mono text-blue-600 dark:text-blue-400 bg-slate-100 dark:bg-slate-800 px-1 py-0.5 rounded">
                    {settings.github_last_synced_sha.slice(0, 7)}
                  </code>
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={pullingGh}
                  disabled={!settings.github_token || !settings.github_repo}
                  icon={<Download size={12} />}
                  onClick={handlePullGitHub}
                  title="Pull analyzed games from GitHub into this instance"
                >
                  Pull Analyses from GitHub
                </Button>
                {pullResult.ok !== null && (
                  <span
                    className={`text-xs flex items-center gap-1 ${pullResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                  >
                    {pullResult.ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                    {pullResult.message}
                  </span>
                )}
                {pullResult.ok === null && pullResult.message && (
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {pullResult.message}
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
                  title="Push all local analyzed games to your GitHub repository"
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
