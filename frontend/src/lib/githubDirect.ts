/**
 * GitHub Direct Client Mode — allows PlyProse to run serverlessly on mobile or GitHub Pages,
 * directly querying game analysis reports, PGNs, PDFs, and diagrams from the user's private GitHub repository.
 */

import { Chess } from 'chess.js';
import { marked } from 'marked';
import type { AnalysisRecord, GameRecord, GamesResponse, Settings } from '../types';

const STORAGE_SETTINGS_KEY = 'plyprose_direct_settings';

export interface RemoteGameFolder {
  folder: string;
  reportBlobSha: string;
  pgnBlobSha: string;
  payloadBlobSha?: string;
  reportPdfBlobSha?: string;
  diagramBlobs: Record<string, string>; // e.g. 'assets/diagram_1.svg' -> sha
}

export function getLocalSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS_KEY);
    if (raw) {
      return JSON.parse(raw) as Settings;
    }
  } catch {
    /* ignore */
  }
  return {
    elo: 1200,
    goals: '',
    chesscom_username: '',
    lichess_username: '',
    stockfish_path: '',
    stockfish_depth: 18,
    stockfish_time: 0.15,
    llm_provider: 'gemini',
    llm_base_url: '',
    llm_api_key: '',
    llm_model: 'gemini-2.5-flash',
    github_enabled: true,
    github_token: '',
    github_repo: '',
    github_branch: 'main',
    github_auto_pull: true,
  };
}

export function saveLocalSettings(data: Partial<Settings>): Settings {
  const current = getLocalSettings();
  const updated = { ...current, ...data };
  try {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(updated));
  } catch {
    /* ignore */
  }
  return updated;
}

export function isGitHubDirectConfigured(): boolean {
  const s = getLocalSettings();
  return Boolean(s.github_token && s.github_repo);
}

// In-memory cache for blobs to prevent redundant GitHub API requests
const _blobCache = new Map<string, string>();
const _rawBlobCache = new Map<string, ArrayBuffer>();
let _remoteFoldersCache: RemoteGameFolder[] | null = null;
let _remoteFoldersCacheTime = 0;

export function clearBlobCache(): void {
  _blobCache.clear();
  _rawBlobCache.clear();
  _remoteFoldersCache = null;
  _remoteFoldersCacheTime = 0;
}

function b64DecodeUnicode(str: string): string {
  try {
    return decodeURIComponent(
      atob(str.replace(/\s+/g, ''))
        .split('')
        .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
  } catch {
    return atob(str.replace(/\s+/g, ''));
  }
}

async function githubFetch<T>(endpoint: string, token: string, options?: RequestInit): Promise<T> {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `https://api.github.com${cleanEndpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const errorBody = (await res.json().catch(() => ({}))) as { message?: string };
    const msg = errorBody.message || res.statusText;
    throw new Error(`GitHub API error (${res.status}): ${msg}`);
  }

  return res.json() as Promise<T>;
}

interface TreeItem {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface TreeResponse {
  sha: string;
  tree: TreeItem[];
  truncated: boolean;
}

interface BlobResponse {
  sha: string;
  content: string;
  encoding: string;
}

export async function fetchRemoteFolders(force = false): Promise<RemoteGameFolder[]> {
  const now = Date.now();
  if (!force && _remoteFoldersCache && now - _remoteFoldersCacheTime < 180_000) {
    return _remoteFoldersCache;
  }

  const s = getLocalSettings();
  if (!s.github_token || !s.github_repo) {
    return [];
  }

  const repo = s.github_repo.trim().replace(/^\/|\/$/g, '');
  const branch = (s.github_branch || 'main').trim();

  // 1. Get branch commit ref
  const refData = await githubFetch<{ object: { sha: string } }>(
    `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    s.github_token,
  );
  const commitSha = refData.object.sha;

  // 2. Get recursive tree
  const treeData = await githubFetch<TreeResponse>(
    `/repos/${repo}/git/trees/${commitSha}?recursive=1`,
    s.github_token,
  );

  const foldersMap = new Map<
    string,
    {
      report?: string;
      pgn?: string;
      payload?: string;
      reportPdf?: string;
      diagrams: Record<string, string>;
    }
  >();

  for (const item of treeData.tree) {
    if (item.type !== 'blob') continue;
    const path = item.path;
    const slashIdx = path.lastIndexOf('/');
    if (slashIdx === -1) continue;

    const folder = path.slice(0, slashIdx);
    const filename = path.slice(slashIdx + 1);

    let entry = foldersMap.get(folder);
    if (!entry) {
      entry = { diagrams: {} };
      foldersMap.set(folder, entry);
    }

    if (filename === 'report.md') {
      entry.report = item.sha;
    } else if (filename === 'game.pgn') {
      entry.pgn = item.sha;
    } else if (filename === 'payload.json') {
      entry.payload = item.sha;
    } else if (filename === 'report.pdf') {
      entry.reportPdf = item.sha;
    } else if (filename.endsWith('.svg') && folder.endsWith('/assets')) {
      const parentFolder = folder.slice(0, folder.lastIndexOf('/'));
      let parentEntry = foldersMap.get(parentFolder);
      if (!parentEntry) {
        parentEntry = { diagrams: {} };
        foldersMap.set(parentFolder, parentEntry);
      }
      parentEntry.diagrams[`assets/${filename}`] = item.sha;
    }
  }

  const result: RemoteGameFolder[] = [];
  for (const [folder, files] of foldersMap.entries()) {
    if (files.report && files.pgn) {
      result.push({
        folder,
        reportBlobSha: files.report,
        pgnBlobSha: files.pgn,
        payloadBlobSha: files.payload,
        reportPdfBlobSha: files.reportPdf,
        diagramBlobs: files.diagrams,
      });
    }
  }

  // Sort descending by folder path (which starts with date)
  result.sort((a, b) => b.folder.localeCompare(a.folder));

  _remoteFoldersCache = result;
  _remoteFoldersCacheTime = now;
  return result;
}

export async function fetchBlobText(sha: string): Promise<string> {
  if (_blobCache.has(sha)) {
    return _blobCache.get(sha)!;
  }

  const s = getLocalSettings();
  if (!s.github_token || !s.github_repo) {
    throw new Error('GitHub settings not configured');
  }

  const repo = s.github_repo.trim().replace(/^\/|\/$/g, '');
  const data = await githubFetch<BlobResponse>(`/repos/${repo}/git/blobs/${sha}`, s.github_token);

  const text = data.encoding === 'base64' ? b64DecodeUnicode(data.content) : data.content;

  _blobCache.set(sha, text);
  return text;
}

export async function fetchBlobRaw(sha: string): Promise<ArrayBuffer> {
  if (_rawBlobCache.has(sha)) {
    return _rawBlobCache.get(sha)!;
  }

  const s = getLocalSettings();
  if (!s.github_token || !s.github_repo) {
    throw new Error('GitHub settings not configured');
  }

  const repo = s.github_repo.trim().replace(/^\/|\/$/g, '');
  const data = await githubFetch<BlobResponse>(`/repos/${repo}/git/blobs/${sha}`, s.github_token);

  let buffer: ArrayBuffer;
  if (data.encoding === 'base64') {
    const binStr = atob(data.content.replace(/\s+/g, ''));
    const len = binStr.length;
    buffer = new ArrayBuffer(len);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < len; i++) {
      view[i] = binStr.charCodeAt(i);
    }
  } else {
    const encoded = new TextEncoder().encode(data.content);
    buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  }

  _rawBlobCache.set(sha, buffer);
  return buffer;
}

export function parseFolderMetadata(folder: string): {
  platform: string;
  speed: string;
  yearMonth: string;
  dateStr: string;
  playedAt: string;
  white: string;
  black: string;
  result: string;
} {
  const parts = folder.split('/');
  // Expected: [platform, speed, yearMonth, folderName]
  const platform = parts[0] ? parts[0].replace(/\.org|\.com/g, '') : 'manual';
  const speed = parts[1] || 'rapid';
  const yearMonth = parts[2] || '';
  const folderName = parts[3] || '';

  let white = 'White';
  let black = 'Black';
  let result = '*';
  let dateStr = '';
  let playedAt = '';

  // Robust format match: DD-HHMM-players-winner
  const m = folderName.match(/^(\d{2})-(\d{4})-(.+)-(white|black|draw|unknown)$/);
  if (m) {
    const day = m[1];
    const time = m[2];
    const playersStr = m[3];
    const winner = m[4];

    if (winner === 'white') result = '1-0';
    else if (winner === 'black') result = '0-1';
    else if (winner === 'draw') result = '1/2-1/2';

    if (yearMonth) {
      dateStr = `${yearMonth.replace('-', '.')}.${day}`;
      playedAt = `${yearMonth}-${day} ${time.slice(0, 2)}:${time.slice(2, 4)}:00`;
    }

    const playerSegments = playersStr.split('-');
    if (playerSegments.length === 2) {
      white = playerSegments[0].replace(/_/g, ' ');
      black = playerSegments[1].replace(/_/g, ' ');
    } else if (playerSegments.length > 2) {
      const mid = Math.ceil(playerSegments.length / 2);
      white = playerSegments.slice(0, mid).join(' ').replace(/_/g, ' ');
      black = playerSegments.slice(mid).join(' ').replace(/_/g, ' ');
    } else {
      white = playersStr.replace(/_/g, ' ');
      black = 'Opponent';
    }
  } else if (folderName) {
    // Fallback: extract date/time if prefix matches
    const prefixMatch = folderName.match(/^(\d{2})-(\d{4})/);
    if (prefixMatch && yearMonth) {
      const day = prefixMatch[1];
      const time = prefixMatch[2];
      dateStr = `${yearMonth.replace('-', '.')}.${day}`;
      playedAt = `${yearMonth}-${day} ${time.slice(0, 2)}:${time.slice(2, 4)}:00`;
    }
  }

  return {
    platform,
    speed,
    yearMonth,
    dateStr,
    playedAt,
    white,
    black,
    result,
  };
}

export function findTargetFolder(
  folders: RemoteGameFolder[],
  identifier: number | string,
): RemoteGameFolder | undefined {
  const identStr = String(identifier).trim();

  // 1. Check numeric index (1-based from games table)
  const num = Number(identStr);
  if (!Number.isNaN(num) && String(num) === identStr) {
    const idx = num - 1;
    if (idx >= 0 && idx < folders.length) {
      return folders[idx];
    }
  }

  // 2. Exact folder path match
  const exact = folders.find(f => f.folder === identStr);
  if (exact) return exact;

  // 3. Exact folder name (last segment)
  const byName = folders.find(f => f.folder.endsWith(`/${identStr}`));
  if (byName) return byName;

  // 4. Fallback contains (only for non-numeric or long identifiers to avoid accidental matches)
  if (identStr.length > 3) {
    return folders.find(f => f.folder.includes(identStr));
  }
  return undefined;
}

export async function getGitHubDirectGames(
  params: Record<string, string | number>,
): Promise<GamesResponse> {
  const folders = await fetchRemoteFolders();

  const page = Number(params.page || 1);
  const pageSize = Number(params.page_size || 10);
  const statusFilter = String(params.status || 'all');
  const resultFilter = String(params.result || 'all');
  const platformFilter = String(params.platform || 'all').toLowerCase();
  const categoryFilter = String(params.category || 'all').toLowerCase();
  const q = String(params.search || params.q || '')
    .toLowerCase()
    .trim();
  const tagFilter = String(params.tag || '')
    .toLowerCase()
    .trim();
  const sortBy = String(params.sort_by || 'date');
  const sortOrder = String(params.sort_order || 'desc');

  const allRecords: GameRecord[] = folders.map((rf, idx) => {
    const meta = parseFolderMetadata(rf.folder);
    return {
      id: idx + 1,
      game_key: rf.folder,
      created_at: meta.playedAt || new Date().toISOString(),
      played_at: meta.playedAt,
      date: meta.dateStr,
      white_player: meta.white,
      black_player: meta.black,
      result: meta.result,
      time_control: meta.speed,
      opening_name: null,
      total_plies: 40,
      moves_count: 20,
      critical_moments_count: 3,
      model_name: 'github-direct',
      platform: meta.platform,
      speed_label: meta.speed.charAt(0).toUpperCase() + meta.speed.slice(1),
      analyzed: true,
      github_path: rf.folder,
      github_sync_status: 'synced',
    };
  });

  const filtered = allRecords.filter(g => {
    if (statusFilter === 'unanalyzed') return false; // all remote games are analyzed
    if (resultFilter === 'win' && g.result !== '1-0') return false;
    if (resultFilter === 'loss' && g.result !== '0-1') return false;
    if (resultFilter === 'draw' && g.result !== '1/2-1/2') return false;
    if (platformFilter !== 'all' && !g.platform?.toLowerCase().includes(platformFilter)) {
      return false;
    }
    if (categoryFilter !== 'all' && !g.time_control.toLowerCase().includes(categoryFilter)) {
      return false;
    }
    if (q) {
      const matchWhite = g.white_player.toLowerCase().includes(q);
      const matchBlack = g.black_player.toLowerCase().includes(q);
      const matchOpening = g.opening_name?.toLowerCase().includes(q);
      if (!matchWhite && !matchBlack && !matchOpening) return false;
    }
    if (tagFilter && tagFilter !== 'all') {
      if (!g.tags || !g.tags.some(t => t.toLowerCase() === tagFilter)) return false;
    }
    return true;
  });

  if (sortBy === 'moves') {
    filtered.sort((a, b) =>
      sortOrder === 'asc' ? a.total_plies - b.total_plies : b.total_plies - a.total_plies,
    );
  } else {
    filtered.sort((a, b) => {
      const comp = (b.played_at || b.created_at).localeCompare(a.played_at || a.created_at);
      return sortOrder === 'asc' ? -comp : comp;
    });
  }

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const games = filtered.slice(start, start + pageSize);

  return {
    total,
    page,
    page_size: pageSize,
    pages,
    games,
  };
}

export async function getGitHubDirectAnalysis(
  identifier: number | string,
): Promise<AnalysisRecord> {
  const folders = await fetchRemoteFolders();
  const target = findTargetFolder(folders, identifier);

  if (!target) {
    throw new Error(`Game analysis not found for '${identifier}' in GitHub repository.`);
  }

  const [pgnText, reportMd, payloadRaw] = await Promise.all([
    fetchBlobText(target.pgnBlobSha),
    fetchBlobText(target.reportBlobSha),
    target.payloadBlobSha ? fetchBlobText(target.payloadBlobSha) : Promise.resolve(null),
  ]);

  const meta = parseFolderMetadata(target.folder);

  let whitePlayer = meta.white;
  let blackPlayer = meta.black;
  let gameResult = meta.result;
  let timeControl = meta.speed;
  let openingName: string | null = null;
  let dateStr = meta.dateStr;
  let playedAt = meta.playedAt;
  let platform = meta.platform;
  let totalPlies = 0;
  let movesCount = 0;
  let plyEvals: number[] | undefined;
  let criticalMomentsCount = 0;
  let tags: string[] = [];
  let gameUrl: string | undefined;

  if (payloadRaw) {
    try {
      const parsed = JSON.parse(payloadRaw) as Record<string, unknown>;
      if (typeof parsed.white_player === 'string' && parsed.white_player) {
        whitePlayer = parsed.white_player;
      }
      if (typeof parsed.black_player === 'string' && parsed.black_player) {
        blackPlayer = parsed.black_player;
      }
      if (typeof parsed.result === 'string' && parsed.result) {
        gameResult = parsed.result;
      }
      if (typeof parsed.time_control === 'string' && parsed.time_control) {
        timeControl = parsed.time_control;
      }
      if (typeof parsed.opening_name === 'string' && parsed.opening_name) {
        openingName = parsed.opening_name;
      }
      if (typeof parsed.date === 'string' && parsed.date) {
        dateStr = parsed.date;
      }
      if (typeof parsed.played_at === 'string' && parsed.played_at) {
        playedAt = parsed.played_at;
      }
      if (typeof parsed.platform === 'string' && parsed.platform) {
        platform = parsed.platform;
      }
      if (typeof parsed.game_url === 'string' && parsed.game_url) {
        gameUrl = parsed.game_url;
      }
      if (typeof parsed.total_plies === 'number') {
        totalPlies = parsed.total_plies;
        movesCount = Math.ceil((totalPlies + 1) / 2);
      }
      if (Array.isArray(parsed.ply_evals)) {
        plyEvals = parsed.ply_evals as number[];
      }
      if (Array.isArray(parsed.critical_moments)) {
        criticalMomentsCount = parsed.critical_moments.length;
      }
      if (Array.isArray(parsed.tags)) {
        tags = parsed.tags as string[];
      }
    } catch {
      /* ignore */
    }
  }

  if (pgnText) {
    try {
      const c = new Chess();
      c.loadPgn(pgnText);
      if (!totalPlies) {
        totalPlies = c.history().length;
        movesCount = Math.ceil(totalPlies / 2);
      }
      const headers = c.header();
      if (!payloadRaw) {
        if (headers['White']) whitePlayer = headers['White'];
        if (headers['Black']) blackPlayer = headers['Black'];
        if (headers['Result']) gameResult = headers['Result'];
        if (headers['Date'] && !dateStr) dateStr = headers['Date'];
        if (headers['TimeControl'] && timeControl === 'rapid') timeControl = headers['TimeControl'];
        const link = headers['Link'] || headers['Site'];
        if (link) gameUrl = link;
      }
      if (!openingName) {
        openingName = headers['Opening'] || headers['ECO'] || null;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    id: folders.indexOf(target) + 1,
    game_key: target.folder,
    created_at: playedAt || new Date().toISOString(),
    played_at: playedAt,
    date: dateStr,
    white_player: whitePlayer,
    black_player: blackPlayer,
    result: gameResult,
    time_control: timeControl,
    opening_name: openingName,
    total_plies: totalPlies,
    moves_count: movesCount,
    critical_moments_count: criticalMomentsCount,
    model_name: 'github-direct',
    pgn_text: pgnText,
    report_md: reportMd,
    payload_json: payloadRaw || undefined,
    platform: platform,
    github_path: target.folder,
    github_sync_status: 'synced',
    ply_evals: plyEvals,
    tags,
    game_url: gameUrl,
  };
}

export async function getGitHubDirectReportHtml(
  identifier: number | string,
): Promise<{ report_html: string; report_md: string }> {
  const folders = await fetchRemoteFolders();
  const target = findTargetFolder(folders, identifier);

  if (!target) {
    throw new Error(`Report not found for '${identifier}' in GitHub repository.`);
  }

  const reportMd = await fetchBlobText(target.reportBlobSha);

  // Replace relative diagram image paths (./assets/diagram_N.svg and assets/diagram_N.svg) with inline data URI SVGs concurrently
  let processedMd = reportMd;
  const diagramEntries = Object.entries(target.diagramBlobs);
  if (diagramEntries.length > 0) {
    const svgResults = await Promise.all(
      diagramEntries.map(async ([diagramPath, blobSha]) => {
        try {
          const svgText = await fetchBlobText(blobSha);
          return { diagramPath, svgText };
        } catch {
          return { diagramPath, svgText: null };
        }
      }),
    );

    for (const { diagramPath, svgText } of svgResults) {
      if (svgText) {
        const dataUri = `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`;
        processedMd = processedMd.split(`./${diagramPath}`).join(dataUri);
        processedMd = processedMd.split(diagramPath).join(dataUri);
      }
    }
  }

  // Convert markdown to HTML via marked
  const parsedHtml = await marked.parse(processedMd);

  return {
    report_html: parsedHtml,
    report_md: reportMd,
  };
}

export async function downloadGitHubDirectPdf(identifier: number | string): Promise<void> {
  const folders = await fetchRemoteFolders();
  const target = findTargetFolder(folders, identifier);

  if (!target || !target.reportPdfBlobSha) {
    throw new Error('PDF report not found in GitHub repository for this game.');
  }

  const buffer = await fetchBlobRaw(target.reportPdfBlobSha);
  const blob = new Blob([buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = target.folder.split('/').pop() || 'report';
  a.download = `${slug}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
