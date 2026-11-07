export type Variant = 'emerald' | 'rose' | 'slate' | 'blue' | 'amber' | 'violet';

export type UserOutcome = 'win' | 'loss' | 'draw' | 'unknown';

export function getUserOutcome(
  result: string,
  side?: string,
  whitePlayer?: string,
  blackPlayer?: string,
  userNames?: string[],
): UserOutcome {
  const normResult = (result || '').trim();
  if (normResult === '1/2-1/2' || normResult.toLowerCase() === 'draw') return 'draw';
  if (normResult !== '1-0' && normResult !== '0-1') return 'unknown';

  let resolvedSide = (side || '').toLowerCase().trim();
  if (!resolvedSide || resolvedSide === 'both' || resolvedSide === 'auto') {
    const candidates = ['tuxitop', ...(userNames || [])]
      .map(u => u.toLowerCase().trim())
      .filter(Boolean);
    const whiteLower = (whitePlayer || '').toLowerCase().trim();
    const blackLower = (blackPlayer || '').toLowerCase().trim();

    if (candidates.some(c => whiteLower === c || whiteLower.includes(c))) {
      resolvedSide = 'white';
    } else if (candidates.some(c => blackLower === c || blackLower.includes(c))) {
      resolvedSide = 'black';
    }
  }

  if (resolvedSide === 'white') {
    return normResult === '1-0' ? 'win' : 'loss';
  }
  if (resolvedSide === 'black') {
    return normResult === '0-1' ? 'win' : 'loss';
  }

  // Fallback if no side could be resolved
  return normResult === '1-0' ? 'win' : 'loss';
}

export function resultBadgeVariant(
  result: string,
  side?: string,
  whitePlayer?: string,
  blackPlayer?: string,
  userNames?: string[],
): Variant {
  const outcome = getUserOutcome(result, side, whitePlayer, blackPlayer, userNames);
  if (outcome === 'win') return 'emerald';
  if (outcome === 'loss') return 'rose';
  return 'slate';
}

export function resultLabel(
  result: string,
  side?: string,
  whitePlayer?: string,
  blackPlayer?: string,
  userNames?: string[],
): string {
  const outcome = getUserOutcome(result, side, whitePlayer, blackPlayer, userNames);
  if (outcome === 'win') return 'Win';
  if (outcome === 'loss') return 'Loss';
  if (outcome === 'draw') return 'Draw';
  return result;
}

export function platformBadgeVariant(platform?: string): Variant {
  const p = (platform || '').toLowerCase();
  if (p === 'chesscom') return 'slate';
  if (p === 'lichess') return 'blue';
  return 'slate';
}

export function platformLabel(platform?: string): string {
  const p = (platform || '').toLowerCase();
  if (p === 'chesscom') return 'chess.com';
  if (p === 'lichess') return 'lichess';
  return platform || 'manual';
}

export function formatPlyEval(evalCp: number | null | undefined): string | null {
  if (evalCp === null || evalCp === undefined) return null;
  if (evalCp >= 9900) {
    const mate = 10000 - evalCp;
    return `+M${Math.max(1, mate)}`;
  }
  if (evalCp <= -9900) {
    const mate = 10000 + evalCp;
    return `-M${Math.max(1, Math.abs(mate))}`;
  }
  // Clamp displayed non-mate pawn evaluations to [-10.0, +10.0] pawns,
  // following standard chess platforms (Lichess/Chess.com)
  const clampedCp = Math.max(-1000, Math.min(1000, evalCp));
  const pawn = (clampedCp / 100).toFixed(1);
  return clampedCp > 0 ? `+${pawn}` : pawn;
}

export type ClassificationType =
  'blunder' | 'mistake' | 'inaccuracy' | 'miss' | 'brilliant' | 'great' | 'best' | 'checkmate';

export interface ClassificationBadge {
  symbol: string;
  label: string;
  bgClass: string;
  type: ClassificationType;
}

export function getClassificationBadge(classification?: string): ClassificationBadge | null {
  if (!classification) return null;
  const lower = classification.toLowerCase();
  if (lower.includes('checkmate') || classification.includes('#')) {
    return { symbol: '#', label: 'Checkmate', bgClass: 'bg-emerald-600', type: 'checkmate' };
  }
  if (lower.includes('missed win') || lower.includes('missed tactic') || lower.includes('miss')) {
    return { symbol: '⨉', label: classification, bgClass: 'bg-rose-700', type: 'miss' };
  }
  if (lower.includes('blunder')) {
    return { symbol: '??', label: 'Blunder', bgClass: 'bg-rose-600', type: 'blunder' };
  }
  if (lower.includes('mistake')) {
    return { symbol: '?', label: 'Mistake', bgClass: 'bg-orange-500', type: 'mistake' };
  }
  if (lower.includes('inaccuracy')) {
    return {
      symbol: '?!',
      label: 'Inaccuracy',
      bgClass: 'bg-amber-500 text-slate-900',
      type: 'inaccuracy',
    };
  }
  if (lower.includes('brilliant')) {
    return { symbol: '!!', label: 'Brilliant', bgClass: 'bg-cyan-500', type: 'brilliant' };
  }
  if (lower.includes('great') || lower.includes('critical turning point')) {
    return { symbol: '!', label: 'Great Move', bgClass: 'bg-blue-600', type: 'great' };
  }
  if (lower.includes('best move') || lower === 'best') {
    return { symbol: '★', label: 'Best Move', bgClass: 'bg-emerald-600', type: 'best' };
  }
  return null;
}

export function formatSecondsToClock(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function getBaseClockSeconds(
  timeControlStr?: string | null,
  plyClocks?: (number | null)[] | null,
): number | null {
  if (plyClocks && typeof plyClocks[0] === 'number' && plyClocks[0] > 0) {
    return plyClocks[0];
  }
  if (!timeControlStr) return null;
  const tc = timeControlStr.trim();
  const m = tc.match(/^(\d+)(?:\+(\d+))?/);
  if (m) {
    const val = parseInt(m[1], 10);
    if (val >= 30) return val;
    return val * 60;
  }
  return null;
}

export function getClassificationTextColor(type?: ClassificationType | null): string {
  if (!type) return '';
  switch (type) {
    case 'blunder':
      return 'text-rose-600 dark:text-rose-400 font-bold';
    case 'mistake':
      return 'text-orange-600 dark:text-orange-400 font-bold';
    case 'inaccuracy':
      return 'text-amber-600 dark:text-amber-400 font-bold';
    case 'miss':
      return 'text-rose-700 dark:text-rose-400 font-bold';
    case 'brilliant':
      return 'text-cyan-600 dark:text-cyan-400 font-bold';
    case 'great':
      return 'text-blue-600 dark:text-blue-400 font-bold';
    case 'best':
      return 'text-emerald-600 dark:text-emerald-400 font-bold';
    case 'checkmate':
      return 'text-emerald-600 dark:text-emerald-400 font-bold';
  }
}

export interface TagBadgeConfig {
  label: string;
  bgClass: string;
  textClass: string;
  category: 'tactic' | 'opening' | 'strategy' | 'endgame' | 'general' | 'time';
}

export const TAG_LABELS: Record<string, string> = {
  // Tactics: Missed Opportunities
  'tactic:missed-fork': 'Missed Fork',
  'tactic:missed-pin': 'Missed Pin',
  'tactic:missed-skewer': 'Missed Skewer',
  'tactic:missed-discovery': 'Missed Discovery',
  'tactic:missed-mate': 'Missed Mate',
  'tactic:missed-win': 'Missed Win',
  'tactic:missed-tactic': 'Missed Tactic',
  'tactic:missed-hanging-piece': 'Missed Free Piece',
  'tactic:missed-back-rank': 'Missed Back-Rank',
  'tactic:missed-deflection': 'Missed Deflection',
  'tactic:missed-zwischenzug': 'Missed Zwischenzug',
  // Tactics: Blunders & Hanging Pieces
  'tactic:hung-piece': 'Hung Piece',
  'tactic:blundered-piece': 'Hung Piece',
  // Tactics: Found & Executed
  'tactic:found-fork': 'Fork',
  'tactic:found-pin': 'Pin',
  'tactic:found-skewer': 'Skewer',
  'tactic:found-discovery': 'Discovered Attack',
  'tactic:found-mate': 'Checkmate',
  'tactic:found-sacrifice': 'Sacrifice',
  'tactic:hanging-piece-punished': 'Free Piece Won',
  'tactic:back-rank-punished': 'Back-Rank Mate',

  // Time Management
  'time:clutch-play': 'Clutch Play',
  'time:trouble-blunder': 'Time Blunder',
  'time:rushed-blunder': 'Rushed Blunder',
  'time:time-advantage': 'Clock Lead',
  'time:time-sink': 'Time Sink',

  // Opening
  'opening:development-lead': 'Dev Lead',
  'opening:development-lag': 'Dev Lag',
  'opening:early-queen': 'Early Queen',
  'opening:king-in-center': 'King in Center',
  'opening:failed-to-castle': 'Castling Neglected',
  'opening:pawn-overextension': 'Pawn Overextension',
  'opening:wasted-tempo': 'Wasted Tempo',
  'opening:center-control': 'Center Control',

  // Strategy
  'strategy:piece-coordination': 'Piece Coordination',
  'strategy:outpost-control': 'Outpost Dominance',
  'strategy:open-file-control': 'Open File',
  'strategy:weak-squares': 'Weak Squares',
  'strategy:isolated-pawn': 'Isolated Pawn',
  'strategy:doubled-pawns': 'Compromised Pawns',
  'strategy:king-safety-risk': 'King Safety',
  'strategy:pawn-storm': 'Pawn Storm',
  'strategy:passive-defense': 'Passive Defense',
  'strategy:overextended-attack': 'Overextended Attack',

  // Endgame
  'endgame:passed-pawn-created': 'Passed Pawn',
  'endgame:passed-pawn-missed': 'Allowed Passed Pawn',
  'endgame:active-rook': 'Active Rook',
  'endgame:passive-rook': 'Passive Rook',
  'endgame:king-centralization': 'Active King',
  'endgame:pawn-race': 'Pawn Race',
  'endgame:opposition': 'Opposition',
  'endgame:technical-conversion': 'Smooth Conversion',
  'endgame:stalemate-trap': 'Stalemate Resource',

  // General
  'general:time-trouble': 'Time Trouble',
  'general:resilient-defense': 'Resilient Defense',
  'general:comeback-win': 'Comeback',
  'general:missed-simplification': 'Missed Simplification',
};

export const POSITIVE_TAGS: ReadonlySet<string> = new Set([
  'tactic:found-mate',
  'tactic:found-sacrifice',
  'tactic:found-fork',
  'tactic:found-pin',
  'tactic:found-skewer',
  'tactic:found-discovery',
  'tactic:hanging-piece-punished',
  'tactic:back-rank-punished',
  'time:clutch-play',
  'time:time-advantage',
  'opening:development-lead',
  'opening:center-control',
  'strategy:piece-coordination',
  'strategy:outpost-control',
  'strategy:open-file-control',
  'endgame:passed-pawn-created',
  'endgame:active-rook',
  'endgame:king-centralization',
  'endgame:opposition',
  'endgame:technical-conversion',
  'endgame:stalemate-trap',
  'general:comeback-win',
  'general:resilient-defense',
]);

export function isPositiveTag(tag: string): boolean {
  const norm = tag.toLowerCase().trim();
  return POSITIVE_TAGS.has(norm);
}

export function sortTagsNegativeFirst(tags: string[]): string[] {
  const negatives: string[] = [];
  const positives: string[] = [];
  for (const t of tags) {
    if (isPositiveTag(t)) {
      positives.push(t);
    } else {
      negatives.push(t);
    }
  }
  return [...negatives, ...positives];
}

export function splitTag(tag: string): { category: string; name: string } {
  const norm = tag.toLowerCase().trim();
  const parts = norm.split(':');
  const cat = parts.length > 1 ? parts[0] : 'general';
  const name = TAG_LABELS[norm] || parts.slice(1).join(' ').replace(/-/g, ' ') || norm;
  return { category: cat.toUpperCase(), name };
}

export interface TagCapsuleStyle {
  category: string;
  compactCategory: string;
  name: string;
  isPositive: boolean;
  categoryBg: string;
  categoryText: string;
  valueBg: string;
  valueText: string;
  border: string;
}

export function getTagCapsuleConfig(tag: string): TagCapsuleStyle {
  const norm = tag.toLowerCase().trim();
  const { category, name } = splitTag(norm);
  const positive = isPositiveTag(norm);

  let categoryBg = 'bg-slate-200 dark:bg-slate-700';
  let categoryText = 'text-slate-700 dark:text-slate-300';
  let compactCategory = category.slice(0, 1);

  if (category === 'TACTIC') {
    categoryBg = 'bg-purple-100 dark:bg-purple-950/70';
    categoryText = 'text-purple-700 dark:text-purple-300';
    compactCategory = 'T';
  } else if (category === 'OPENING') {
    categoryBg = 'bg-indigo-100 dark:bg-indigo-950/70';
    categoryText = 'text-indigo-700 dark:text-indigo-300';
    compactCategory = 'O';
  } else if (category === 'STRATEGY') {
    categoryBg = 'bg-blue-100 dark:bg-blue-950/70';
    categoryText = 'text-blue-700 dark:text-blue-300';
    compactCategory = 'S';
  } else if (category === 'ENDGAME') {
    categoryBg = 'bg-teal-100 dark:bg-teal-950/70';
    categoryText = 'text-teal-700 dark:text-teal-300';
    compactCategory = 'E';
  } else if (category === 'TIME') {
    categoryBg = 'bg-amber-100 dark:bg-amber-950/70';
    categoryText = 'text-amber-800 dark:text-amber-300';
    compactCategory = '⏱';
  } else if (category === 'GENERAL') {
    compactCategory = 'G';
  }

  const valueBg = positive
    ? 'bg-emerald-50 dark:bg-emerald-950/40'
    : 'bg-rose-50 dark:bg-rose-950/40';
  const valueText = positive
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-rose-700 dark:text-rose-300';
  const border = positive
    ? 'border-emerald-200 dark:border-emerald-800/60'
    : 'border-rose-200 dark:border-rose-800/60';

  return {
    category,
    compactCategory,
    name,
    isPositive: positive,
    categoryBg,
    categoryText,
    valueBg,
    valueText,
    border,
  };
}

export function renderTagCapsuleHtml(tag: string, size: 'sm' | 'md' = 'md'): string {
  const cfg = getTagCapsuleConfig(tag);
  const isSmall = size === 'sm';

  const containerClasses = isSmall
    ? 'inline-flex items-stretch rounded-full text-[10px] font-medium border overflow-hidden select-none align-middle mr-1.5'
    : 'inline-flex items-stretch rounded-full text-xs font-medium border overflow-hidden select-none align-middle mr-1.5';

  const categoryClasses = isSmall
    ? `inline-flex items-center justify-center px-1.5 py-0.5 text-[8px] font-bold tracking-wider uppercase border-r border-slate-300/80 dark:border-slate-700/80 leading-none ${cfg.categoryBg} ${cfg.categoryText}`
    : `inline-flex items-center justify-center px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase border-r border-slate-300/80 dark:border-slate-700/80 leading-none ${cfg.categoryBg} ${cfg.categoryText}`;

  const valueClasses = isSmall
    ? `inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap leading-none ${cfg.valueBg} ${cfg.valueText}`
    : `inline-flex items-center justify-center px-2 py-0.5 text-xs font-semibold whitespace-nowrap leading-none ${cfg.valueBg} ${cfg.valueText}`;

  return `<span class="${containerClasses} ${cfg.border}" title="${cfg.category}: ${cfg.name}"><span class="${categoryClasses}">${cfg.category}</span><span class="${valueClasses}">${cfg.name}</span></span>`;
}

export function renderSquarePillHtml(square: string): string {
  const sq = square.toLowerCase().trim();
  return `<span class="chess-square-pill inline-block px-1.5 py-0.5 mx-0.5 rounded text-[12px] font-mono font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/80 hover:bg-amber-100 dark:hover:bg-amber-900/60 hover:border-amber-400 dark:hover:border-amber-600 transition-colors align-baseline cursor-pointer active:scale-95" data-square="${sq}" title="Click to highlight square ${sq} on board (click again to toggle off)">${sq}</span>`;
}

export function getTagBadge(tag: string): TagBadgeConfig {
  const norm = tag.toLowerCase().trim();
  const label = TAG_LABELS[norm] || norm.split(':').pop()?.replace(/-/g, ' ') || norm;

  if (norm.startsWith('tactic:')) {
    const isMissed = !isPositiveTag(norm);
    return {
      label,
      bgClass: isMissed
        ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800'
        : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800',
      textClass: isMissed
        ? 'text-rose-700 dark:text-rose-300'
        : 'text-emerald-700 dark:text-emerald-300',
      category: 'tactic',
    };
  }

  if (norm.startsWith('opening:')) {
    const isNegative = !isPositiveTag(norm);
    return {
      label,
      bgClass: isNegative
        ? 'bg-violet-50 dark:bg-violet-950/40 border-violet-200 dark:border-violet-800'
        : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800',
      textClass: isNegative
        ? 'text-violet-700 dark:text-violet-300'
        : 'text-emerald-700 dark:text-emerald-300',
      category: 'opening',
    };
  }

  if (norm.startsWith('strategy:')) {
    return {
      label,
      bgClass: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800',
      textClass: 'text-blue-700 dark:text-blue-300',
      category: 'strategy',
    };
  }

  if (norm.startsWith('endgame:')) {
    return {
      label,
      bgClass: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800',
      textClass: 'text-emerald-700 dark:text-emerald-300',
      category: 'endgame',
    };
  }

  if (norm.startsWith('time:')) {
    const isTrouble = !isPositiveTag(norm);
    return {
      label,
      bgClass: isTrouble
        ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800'
        : 'bg-cyan-50 dark:bg-cyan-950/40 border-cyan-200 dark:border-cyan-800',
      textClass: isTrouble
        ? 'text-rose-700 dark:text-rose-300'
        : 'text-cyan-700 dark:text-cyan-300',
      category: 'time',
    };
  }

  return {
    label,
    bgClass: 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700',
    textClass: 'text-slate-700 dark:text-slate-300',
    category: 'general',
  };
}

export interface OpeningDisplayInfo {
  code: string;
  fullName: string;
}

/**
 * Extracts a concise opening code (e.g. "B54", "C62", "D06") and its full descriptive name
 * for hover tooltips from opening_name and/or pgn_text headers.
 */
export function extractOpeningCodeAndName(
  openingName?: string | null,
  pgnText?: string | null,
): OpeningDisplayInfo | null {
  const rawOpening = (openingName || '').trim();

  // 1. Check if opening_name contains an ECO code (e.g. "B54: Sicilian Defense", "B54", "C62")
  let code: string | null = null;
  const ecoInName = rawOpening.match(/\b([A-E]\d{2})\b/i);
  if (ecoInName) {
    code = ecoInName[1].toUpperCase();
  }

  // 2. Search pgn_text headers for [ECO "..."]
  if (!code && pgnText) {
    const ecoInPgn = pgnText.match(/\[ECO\s+"([A-E]\d{2})"/i);
    if (ecoInPgn) {
      code = ecoInPgn[1].toUpperCase();
    }
  }

  // 3. Resolve the full descriptive name for the tooltip
  let fullName = rawOpening;

  // If opening_name was just the code or missing, inspect PGN headers for descriptive name
  if (pgnText && (!fullName || fullName === code)) {
    const opInPgn = pgnText.match(/\[Opening\s+"([^"]+)"/i);
    if (opInPgn) {
      fullName = opInPgn[1].trim();
    } else {
      const urlMatch = pgnText.match(/\[ECOUrl\s+"[^"]*\/openings\/([^"'\s]+)"/i);
      if (urlMatch) {
        let slug = urlMatch[1].split('...')[0];
        // Strip trailing move numbers like -4.O-O-Bd7 or -3.Qxd4
        slug = slug.replace(/-\d+\..*$/, '');
        fullName = slug.replace(/-/g, ' ');
      }
    }
  }

  // Prepend code to fullName if not already present
  if (code && fullName && !fullName.toUpperCase().startsWith(code)) {
    fullName = `${code}: ${fullName}`;
  } else if (!fullName && code) {
    fullName = code;
  }

  // If still no code, fallback to short name
  if (!code && fullName) {
    if (fullName.length <= 6) {
      code = fullName;
    } else {
      const firstWord = fullName.split(/[:,\s-]+/)[0];
      code = firstWord.length <= 7 ? firstWord : fullName.slice(0, 6);
    }
  }

  if (!code && !fullName) {
    return null;
  }

  return {
    code: code || fullName,
    fullName: fullName || code || '',
  };
}
