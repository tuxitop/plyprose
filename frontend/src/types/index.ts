export interface GameRecord {
  id: number;
  game_key?: string;
  created_at: string;
  white_player: string;
  black_player: string;
  result: string;
  time_control: string;
  opening_name: string | null;
  total_plies: number;
  moves_count?: number;
  critical_moments_count: number;
  model_name: string;
  platform?: string;
  speed_label?: string;
  speed_seconds?: number;
  speed_icon?: string;
  pgn_text?: string;
  report_md?: string;
  analyzed?: boolean;
  white?: string;
  black?: string;
  date?: string;
  played_at?: string;
  side?: string;
  github_path?: string;
  github_sync_status?: 'synced' | 'modified' | 'not_synced' | null;
  github_synced_hash?: string | null;
  game_url?: string;
  ply_evals?: number[];
  tags?: string[];
}

export interface GamesResponse {
  total: number;
  page: number;
  page_size: number;
  pages: number;
  games: GameRecord[];
}

export interface Settings {
  elo: number;
  elo_chesscom_blitz?: number;
  elo_chesscom_rapid?: number;
  elo_lichess_blitz?: number;
  elo_lichess_rapid?: number;
  goals: string;
  chesscom_username: string;
  lichess_username: string;
  stockfish_path: string;
  stockfish_depth: number;
  stockfish_time: number;
  stockfish_limit_mode?: 'both' | 'depth' | 'time';
  stockfish_backward_analysis?: boolean;
  stockfish_version?: string | null;
  llm_provider: string;
  llm_base_url: string;
  llm_api_key: string;
  llm_model: string;
  gemini_api_key?: string;
  gemini_model?: string;
  openai_base_url?: string;
  openai_api_key?: string;
  openai_model?: string;
  github_enabled?: boolean;
  github_auto_pull?: boolean;
  github_token?: string;
  github_repo?: string;
  github_branch?: string;
  github_last_synced_sha?: string;
}

export type SyncTimeRange = '1d' | '1w' | '1month' | 'custom';

export interface SyncOptions {
  platform: 'lichess' | 'chesscom' | 'all';
  timeRange?: SyncTimeRange;
  since?: string;
  until?: string;
  maxGames?: number;
}

export interface DetectedRatingInfo {
  rating: number;
  played_at?: string;
  opponent?: string;
  platform?: string;
  category?: string;
  source?: string;
}

export interface DetectedRatingsResponse {
  pgn_ratings: Record<string, DetectedRatingInfo>;
  live_ratings: Record<string, number>;
  suggestions: Record<string, number>;
}

export interface AnalysisRecord {
  id: number;
  game_key?: string;
  created_at: string;
  white_player: string;
  black_player: string;
  result: string;
  time_control: string;
  opening_name: string | null;
  total_plies: number;
  moves_count?: number;
  critical_moments_count: number;
  model_name: string;
  pgn_text: string;
  report_md: string;
  payload_json?: string;
  played_at?: string;
  date?: string;
  platform?: string;
  side?: string;
  github_path?: string;
  github_sync_status?: 'synced' | 'modified' | 'not_synced' | null;
  github_synced_hash?: string | null;
  game_url?: string;
  ply_evals?: number[];
  tags?: string[];
}

export interface ImportMeta {
  id: string;
  white: string;
  black: string;
  date: string | null;
  result: string;
  time_control: string;
  pgn: string;
}

export interface ImportResult {
  pgn: string;
  meta: ImportMeta;
  resolved_side: string;
  platform?: string;
  pending_id?: number;
}

export interface SyncGame {
  id: string;
  white: string;
  black: string;
  date: string | null;
  result: string;
  time_control: string;
  pgn: string;
}

export interface SyncResult {
  platform: string;
  games: SyncGame[];
  count: number;
}

export interface PlatformPreviewGame {
  id: string;
  platform: string;
  detected_platform?: string;
  source?: string;
  played_at: string;
  date: string | null;
  white: string;
  black: string;
  side: 'white' | 'black' | 'both';
  opponent: string;
  user_elo: number | null;
  opponent_elo: number | null;
  result: string;
  outcome: 'win' | 'loss' | 'draw' | 'unknown';
  time_control: string;
  speed_label: string;
  speed_icon: string;
  already_imported: boolean;
  already_analyzed: boolean;
  already_pending: boolean;
  pgn: string;
}

export interface PlatformPreviewResponse {
  platform: string;
  count: number;
  games: PlatformPreviewGame[];
}

export interface BatchImportGameItem {
  pgn: string;
  platform?: string;
  external_id?: string;
  white?: string;
  black?: string;
  result?: string;
  time_control?: string;
  date?: string | null;
  played_at?: string | null;
  side?: string;
}

export interface BatchImportResponse {
  imported_count: number;
  pending_ids: number[];
}

export interface JobStatus {
  job_id: string;
  status: 'running' | 'done' | 'error';
  analysis_id: number | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
}

export interface GitHubTestResult {
  ok: boolean;
  message: string;
}

export interface GitHubSyncResult {
  ok: boolean;
  already_synced?: boolean;
  commit_sha?: string;
  folder_path?: string;
  message?: string;
}

export interface GitHubSyncAllResult {
  ok: boolean;
  synced_count: number;
  skipped_count?: number;
  total?: number;
  message?: string;
  errors?: string[];
}

export interface GitHubPullResult {
  ok: boolean;
  imported_count: number;
  updated_count: number;
  skipped_count: number;
  purged_pending_count: number;
  total_remote: number;
  errors?: string[];
  message: string;
}

export interface GitHubSmartPullResult {
  ok: boolean;
  status: 'disabled' | 'up_to_date' | 'pulled' | 'error';
  remote_sha?: string | null;
  local_sha?: string | null;
  imported_count: number;
  updated_count: number;
  skipped_count: number;
  message: string;
}

export type Platform = 'all' | 'chesscom' | 'lichess' | 'manual';
export type ResultFilter = 'all' | 'win' | 'loss' | 'draw';
export type StatusFilter = 'all' | 'analyzed' | 'unanalyzed';
export type CategoryFilter =
  'all' | 'UltraBullet' | 'Bullet' | 'Blitz' | 'Rapid' | 'Classical' | 'Daily';

export interface AskMoveRequest {
  ply?: number;
  move_number?: number;
  color?: 'White' | 'Black';
  question: string;
  provider?: string;
  model_name?: string;
}

export interface AskMoveResponse {
  formal_question: string;
  answer_markdown: string;
  move_context: string;
  ply: number;
  move_number: number;
  color: string;
}

export interface AppendQARequest {
  formal_question: string;
  answer_markdown: string;
  move_context: string;
  ply?: number;
}

export interface AppendQAResponse {
  ok: boolean;
  report_html: string;
  report_md: string;
  section_heading: string;
}
