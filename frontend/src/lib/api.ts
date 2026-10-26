import type {
  AnalysisRecord,
  BatchImportGameItem,
  BatchImportResponse,
  ConnectionTestResult,
  DetectedRatingsResponse,
  GamesResponse,
  GitHubSyncAllResult,
  GitHubSyncResult,
  GitHubTestResult,
  ImportResult,
  JobStatus,
  PlatformPreviewResponse,
  Settings,
  SyncOptions,
  SyncResult,
} from '../types';

const BASE = '/api';

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
export const getSettings = () => req<Settings>('/settings');
export const updateSettings = (data: Partial<Settings>) =>
  req<Settings>('/settings', { method: 'PUT', body: JSON.stringify(data) });
export const getDetectedRatings = () => req<DetectedRatingsResponse>('/settings/detected-ratings');
export const testConnection = () =>
  req<ConnectionTestResult>('/settings/test-connection', { method: 'POST' });
export const verifyUsername = (platform: string, username: string) =>
  req<ConnectionTestResult>(
    `/settings/verify-username?platform=${encodeURIComponent(platform)}&username=${encodeURIComponent(username)}`,
    { method: 'POST' },
  );
export const listModels = () => req<{ models: string[] }>('/llm/models');

// ── GitHub Sync ────────────────────────────────────────────────────────────────
export const testGitHubConnection = (payload?: {
  token?: string;
  repo?: string;
  branch?: string;
}) =>
  req<GitHubTestResult>('/github/test-connection', {
    method: 'POST',
    body: JSON.stringify(payload ?? {}),
  });
export const syncGameToGitHub = (analysisId: number, force = false) =>
  req<GitHubSyncResult>(`/github/sync/${analysisId}${force ? '?force=true' : ''}`, {
    method: 'POST',
  });
export const syncAllToGitHub = (force = false) =>
  req<GitHubSyncAllResult>(`/github/sync-all${force ? '?force=true' : ''}`, { method: 'POST' });

// ── Games ─────────────────────────────────────────────────────────────────────
export const getGames = (params: Record<string, string | number>) => {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  return req<GamesResponse>(`/games?${qs}`);
};
export const deleteGame = (id: number, isPending = false) =>
  req<{ ok: boolean }>(isPending ? `/games/pending/${id}` : `/games/${id}`, { method: 'DELETE' });

export const updateGamePlatform = (id: number, platform: string, isPending = false) =>
  req<{ ok: boolean }>(`/games/${id}/platform`, {
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
) =>
  req<{ job_id: string }>('/games/analyze', {
    method: 'POST',
    body: JSON.stringify({
      pgn,
      side,
      platform,
      existing_analysis_id: existingId ?? null,
      pending_game_id: pendingGameId ?? null,
    }),
  });

export const getJobStatus = (jobId: string) => req<JobStatus>(`/jobs/${jobId}`);

export const getAnalysis = (id: number) => req<AnalysisRecord>(`/analysis/${id}`);

export const getReportHtml = (id: number) =>
  req<{ report_html: string; report_md: string }>(`/analysis/${id}/report-html`);

export const exportPdfUrl = (id: number) => `${BASE}/analysis/${id}/export/pdf`;
export const exportZipUrl = (id: number) => `${BASE}/analysis/${id}/export/zip`;

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
