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
  if (evalCp >= 9000) {
    const mate = 10000 - evalCp;
    return `+M${Math.max(1, mate)}`;
  }
  if (evalCp <= -9000) {
    const mate = 10000 + evalCp;
    return `-M${Math.max(1, Math.abs(mate))}`;
  }
  const pawn = (evalCp / 100).toFixed(1);
  return evalCp > 0 ? `+${pawn}` : pawn;
}

export function getClassificationBadge(classification?: string) {
  if (!classification) return null;
  const lower = classification.toLowerCase();
  if (lower.includes('checkmate') || classification.includes('#')) {
    return { symbol: '#', label: 'Checkmate', bgClass: 'bg-emerald-600' };
  }
  if (lower.includes('missed win') || lower.includes('missed tactic') || lower.includes('miss')) {
    return { symbol: '❌', label: classification, bgClass: 'bg-rose-700' };
  }
  if (lower.includes('blunder')) {
    return { symbol: '??', label: 'Blunder', bgClass: 'bg-rose-600' };
  }
  if (lower.includes('mistake')) {
    return { symbol: '?', label: 'Mistake', bgClass: 'bg-orange-500' };
  }
  if (lower.includes('inaccuracy')) {
    return { symbol: '?!', label: 'Inaccuracy', bgClass: 'bg-amber-500 text-slate-900' };
  }
  if (lower.includes('brilliant')) {
    return { symbol: '!!', label: 'Brilliant', bgClass: 'bg-cyan-500' };
  }
  if (lower.includes('great') || lower.includes('critical turning point')) {
    return { symbol: '!', label: 'Great Move', bgClass: 'bg-blue-600' };
  }
  return null;
}

export function formatSecondsToClock(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || isNaN(seconds)) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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

  if (category === 'TACTIC') {
    categoryBg = 'bg-purple-100 dark:bg-purple-950/70';
    categoryText = 'text-purple-700 dark:text-purple-300';
  } else if (category === 'OPENING') {
    categoryBg = 'bg-indigo-100 dark:bg-indigo-950/70';
    categoryText = 'text-indigo-700 dark:text-indigo-300';
  } else if (category === 'STRATEGY') {
    categoryBg = 'bg-blue-100 dark:bg-blue-950/70';
    categoryText = 'text-blue-700 dark:text-blue-300';
  } else if (category === 'ENDGAME') {
    categoryBg = 'bg-teal-100 dark:bg-teal-950/70';
    categoryText = 'text-teal-700 dark:text-teal-300';
  } else if (category === 'TIME') {
    categoryBg = 'bg-amber-100 dark:bg-amber-950/70';
    categoryText = 'text-amber-800 dark:text-amber-300';
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
    name,
    isPositive: positive,
    categoryBg,
    categoryText,
    valueBg,
    valueText,
    border,
  };
}

export function renderTagCapsuleHtml(tag: string, size: 'sm' | 'md' = 'sm'): string {
  const cfg = getTagCapsuleConfig(tag);
  const isSmall = size === 'sm';

  const containerClasses = isSmall
    ? 'inline-flex items-center rounded-full text-[10px] font-medium border overflow-hidden shadow-2xs select-none align-middle mr-1.5'
    : 'inline-flex items-center rounded-full text-xs font-medium border overflow-hidden shadow-2xs select-none align-middle mr-1.5';

  const categoryClasses = isSmall
    ? `px-1.5 py-0.2 text-[8px] font-bold tracking-wider uppercase border-r border-slate-300/80 dark:border-slate-700/80 ${cfg.categoryBg} ${cfg.categoryText}`
    : `px-2 py-0.5 text-[9px] font-bold tracking-wider uppercase border-r border-slate-300/80 dark:border-slate-700/80 ${cfg.categoryBg} ${cfg.categoryText}`;

  const valueClasses = isSmall
    ? `px-1.5 py-0.2 text-[10px] font-semibold whitespace-nowrap ${cfg.valueBg} ${cfg.valueText}`
    : `px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${cfg.valueBg} ${cfg.valueText}`;

  return `<span class="${containerClasses} ${cfg.border}" title="${cfg.category}: ${cfg.name}"><span class="${categoryClasses}">${cfg.category}</span><span class="${valueClasses}">${cfg.name}</span></span>`;
}

export function renderSquarePillHtml(square: string): string {
  const sq = square.toLowerCase().trim();
  return `<span class="chess-square-pill inline-flex items-center px-1.5 py-0.2 mx-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/80 select-none align-baseline cursor-pointer" data-square="${sq}" title="Board square ${sq}"><span class="text-[9px] text-amber-500 opacity-75 mr-0.5">⌗</span>${sq}</span>`;
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
