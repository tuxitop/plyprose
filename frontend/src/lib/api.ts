import type {
  AnalysisRecord,
  AnnotateMoveRequest,
  AnnotateMoveResponse,
  AppendQARequest,
  AppendQAResponse,
  AskMoveRequest,
  AskMoveResponse,
  BatchImportGameItem,
  BatchImportResponse,
  ConnectionTestResult,
  DetectedRatingsResponse,
  GamesResponse,
  GitHubPullResult,
  GitHubSmartPullResult,
  GitHubSyncAllResult,
  GitHubSyncResult,
  GitHubTestResult,
  ImportResult,
  JobStatus,
  PlatformPreviewResponse,
  Settings,
  SyncOptions,
  SyncResult,
  UpdatePgnResponse,
} from '../types';
import {
  getGitHubDirectAnalysis,
  getGitHubDirectAvailableTags,
  getGitHubDirectGames,
  getGitHubDirectReportHtml,
  getLocalSettings,
  isGitHubDirectConfigured,
  saveLocalSettings,
} from './githubDirect';

const BASE = '/api';

let _serverReachable: boolean | null = null;

export function isDirectMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hostname.endsWith('github.io')) return true;
  return _serverReachable === false;
}

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...opts?.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Settings ──────────────────────────────────────────────────────────────────
export const getSettings = async (): Promise<Settings> => {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io')) {
    _serverReachable = false;
    return getLocalSettings();
  }
  try {
    const s = await req<Settings>('/settings');
    _serverReachable = true;
    saveLocalSettings(s);
    return s;
  } catch {
    _serverReachable = false;
    return getLocalSettings();
  }
};

export const updateSettings = async (data: Partial<Settings>): Promise<Settings> => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    return saveLocalSettings(data);
  }
  try {
    const res = await req<Settings>('/settings', { method: 'PUT', body: JSON.stringify(data) });
    saveLocalSettings(res);
    return res;
  } catch {
    return saveLocalSettings(data);
  }
};
export const getDetectedRatings = () => req<DetectedRatingsResponse>('/settings/detected-ratings');
export const testConnection = () =>
  req<ConnectionTestResult>('/settings/test-connection', { method: 'POST' });
export const verifyUsername = (platform: string, username: string) =>
  req<ConnectionTestResult>(
    `/settings/verify-username?platform=${encodeURIComponent(platform)}&username=${encodeURIComponent(username)}`,
    { method: 'POST' },
  );
export const listModels = (provider?: string, baseUrl?: string, apiKey?: string) => {
  const params = new URLSearchParams();
  if (provider) params.set('provider', provider);
  if (baseUrl) params.set('base_url', baseUrl);
  if (apiKey) params.set('api_key', apiKey);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return req<{ models: string[] }>(`/llm/models${qs}`);
};

// ── GitHub Sync ────────────────────────────────────────────────────────────────
export const testGitHubConnection = async (payload?: {
  token?: string;
  repo?: string;
  branch?: string;
}): Promise<GitHubTestResult> => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    const s = getLocalSettings();
    const token = payload?.token || s.github_token;
    const repo = (payload?.repo || s.github_repo || '').trim().replace(/^\/|\/$/g, '');
    if (!token) return { ok: false, message: 'GitHub Personal Access Token is required.' };
    if (!repo || !repo.includes('/')) {
      return { ok: false, message: "Repository must be in 'owner/repo' format." };
    }
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (res.ok) {
        return { ok: true, message: `Successfully connected to '${repo}'!` };
      }
      return { ok: false, message: `GitHub returned status ${res.status}: ${res.statusText}` };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `Connection failed: ${msg}` };
    }
  }
  return req<GitHubTestResult>('/github/test-connection', {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  });
};
export const syncGameToGitHub = (analysisId: number | string, force = false) =>
  req<GitHubSyncResult>(
    `/github/sync/${encodeURIComponent(analysisId)}${force ? '?force=true' : ''}`,
    {
      method: 'POST',
    },
  );
export const syncAllToGitHub = (force = false) =>
  req<GitHubSyncAllResult>(`/github/sync-all${force ? '?force=true' : ''}`, { method: 'POST' });
export const pullFromGitHub = (force = false) =>
  req<GitHubPullResult>(`/github/pull${force ? '?force=true' : ''}`, { method: 'POST' });
export const smartPullFromGitHub = async (): Promise<GitHubSmartPullResult> => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    return {
      ok: true,
      status: 'up_to_date',
      imported_count: 0,
      updated_count: 0,
      skipped_count: 0,
      message: 'Running in GitHub Direct mode.',
    };
  }
  try {
    return await req<GitHubSmartPullResult>('/github/smart-pull', { method: 'POST' });
  } catch {
    return {
      ok: true,
      status: 'disabled',
      imported_count: 0,
      updated_count: 0,
      skipped_count: 0,
      message: 'Server offline or sync disabled.',
    };
  }
};

// ── Games ─────────────────────────────────────────────────────────────────────
export const getGames = async (params: Record<string, string | number>): Promise<GamesResponse> => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    return getGitHubDirectGames(params);
  }
  try {
    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ).toString();
    return await req<GamesResponse>(`/games?${qs}`);
  } catch (e) {
    if (isGitHubDirectConfigured()) {
      _serverReachable = false;
      return getGitHubDirectGames(params);
    }
    throw e;
  }
};
export const deleteGame = (id: number | string, isPending = false) =>
  req<{ ok: boolean }>(isPending ? `/games/pending/${id}` : `/games/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

export const updateGamePlatform = (id: number | string, platform: string, isPending = false) =>
  req<{ ok: boolean }>(`/games/${encodeURIComponent(id)}/platform`, {
    method: 'PATCH',
    body: JSON.stringify({ platform, is_pending: isPending }),
  });

export const importGame = (pgn: string, side: string) =>
  req<ImportResult>('/games/import', { method: 'POST', body: JSON.stringify({ pgn, side }) });

export const syncGames = (options: SyncOptions | string, maxGames = 50) => {
  if (typeof options === 'string') {
    return req<SyncResult>(`/games/sync?platform=${options}&max_games=${maxGames}`, {
      method: 'POST',
    });
  }
  const params = new URLSearchParams();
  params.set('platform', options.platform);
  if (options.timeRange) params.set('time_range', options.timeRange);
  if (options.since) params.set('since', options.since);
  if (options.until) params.set('until', options.until);
  params.set('max_games', String(options.maxGames ?? 50));
  return req<SyncResult>(`/games/sync?${params.toString()}`, { method: 'POST' });
};

export const fetchPlatformGames = (options: SyncOptions) => {
  const params = new URLSearchParams();
  params.set('platform', options.platform);
  if (options.timeRange) params.set('time_range', options.timeRange);
  if (options.since) params.set('since', options.since);
  if (options.until) params.set('until', options.until);
  params.set('max_games', String(options.maxGames ?? 50));
  return req<PlatformPreviewResponse>(`/games/fetch-platform-games?${params.toString()}`);
};

export const importBatchGames = (games: BatchImportGameItem[]) =>
  req<BatchImportResponse>('/games/import-batch', {
    method: 'POST',
    body: JSON.stringify({ games }),
  });

// ── Analysis ──────────────────────────────────────────────────────────────────
export const startAnalysis = (
  pgn: string,
  side: string,
  platform: string,
  existingId?: number,
  pendingGameId?: number,
  skipEngine?: boolean,
) =>
  req<{ job_id: string }>('/games/analyze', {
    method: 'POST',
    body: JSON.stringify({
      pgn,
      side,
      platform,
      existing_analysis_id: existingId ?? null,
      pending_game_id: pendingGameId ?? null,
      skip_engine: skipEngine ?? false,
    }),
  });

export const cancelJob = (jobId: string) =>
  req<{ status: string; job_id: string }>(`/jobs/${jobId}/cancel`, { method: 'POST' });

export const getAvailableTags = async () => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    if (isGitHubDirectConfigured()) {
      return getGitHubDirectAvailableTags();
    }
    return { tags: [], counts: {} };
  }
  try {
    return await req<{ tags: string[]; counts: Record<string, number> }>('/tags');
  } catch {
    if (isGitHubDirectConfigured()) {
      return getGitHubDirectAvailableTags();
    }
    return { tags: [], counts: {} };
  }
};

export const getJobStatus = (jobId: string) => req<JobStatus>(`/jobs/${jobId}`);

export const getAnalysis = async (id: number | string): Promise<AnalysisRecord> => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    return getGitHubDirectAnalysis(id);
  }
  try {
    return await req<AnalysisRecord>(`/analysis/${encodeURIComponent(id)}`);
  } catch (e) {
    if (isGitHubDirectConfigured()) {
      _serverReachable = false;
      return getGitHubDirectAnalysis(id);
    }
    throw e;
  }
};

export const getReportHtml = async (
  id: number | string,
): Promise<{ report_html: string; report_md: string }> => {
  if (
    _serverReachable === false ||
    (typeof window !== 'undefined' && window.location.hostname.endsWith('github.io'))
  ) {
    return getGitHubDirectReportHtml(id);
  }
  try {
    return await req<{ report_html: string; report_md: string }>(
      `/analysis/${encodeURIComponent(id)}/report-html`,
    );
  } catch (e) {
    if (isGitHubDirectConfigured()) {
      _serverReachable = false;
      return getGitHubDirectReportHtml(id);
    }
    throw e;
  }
};

export const exportPdfUrl = (id: number | string) =>
  `${BASE}/analysis/${encodeURIComponent(id)}/export/pdf`;
export const exportZipUrl = (id: number | string) =>
  `${BASE}/analysis/${encodeURIComponent(id)}/export/zip`;

export const askMoveQuestion = (analysisId: number | string, data: AskMoveRequest) =>
  req<AskMoveResponse>(`/analysis/${encodeURIComponent(analysisId)}/ask-move`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const appendQAToReport = (analysisId: number | string, data: AppendQARequest) =>
  req<AppendQAResponse>(`/analysis/${encodeURIComponent(analysisId)}/append-qa`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateGamePgn = (analysisId: number | string, pgn: string) =>
  req<UpdatePgnResponse>(`/analysis/${encodeURIComponent(analysisId)}/pgn`, {
    method: 'POST',
    body: JSON.stringify({ pgn }),
  });

export const annotateMove = (analysisId: number | string, data: AnnotateMoveRequest) =>
  req<AnnotateMoveResponse>(`/analysis/${encodeURIComponent(analysisId)}/annotate-move`, {
    method: 'POST',
    body: JSON.stringify(data),
  });

// ── Job SSE stream ─────────────────────────────────────────────────────────────
export function streamJob(
  jobId: string,
  onStep: (data: { step: number; message: string; progress: number }) => void,
  onDone: (data: { analysis_id: number }) => void,
  onError: (data: { message: string }) => void,
): () => void {
  const es = new EventSource(`${BASE}/jobs/${jobId}/stream`);

  es.addEventListener('step', e => {
    try {
      onStep(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('done', e => {
    try {
      onDone(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
    es.close();
  });
  es.addEventListener('error', e => {
    try {
      const d = JSON.parse((e as MessageEvent).data ?? '{}');
      onError(d);
    } catch {
      onError({ message: 'Unknown error' });
    }
    es.close();
  });

  return () => es.close();
}
