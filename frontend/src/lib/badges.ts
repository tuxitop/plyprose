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

export interface TagBadgeConfig {
  label: string;
  bgClass: string;
  textClass: string;
  category: 'tactic' | 'opening' | 'strategy' | 'endgame' | 'general';
}

const TAG_LABELS: Record<string, string> = {
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
  'tactic:found-fork': 'Fork Executed',
  'tactic:found-pin': 'Pin Applied',
  'tactic:found-skewer': 'Skewer Executed',
  'tactic:found-discovery': 'Discovered Attack',
  'tactic:found-mate': 'Checkmate',
  'tactic:found-sacrifice': 'Tactical Sacrifice',
  'tactic:hanging-piece-punished': 'Captured Free Piece',
  'tactic:back-rank-punished': 'Back-Rank Mate',

  'opening:development-lead': 'Lead in Development',
  'opening:development-lag': 'Lag in Development',
  'opening:early-queen': 'Early Queen Attack',
  'opening:king-in-center': 'King in Center',
  'opening:failed-to-castle': 'Castling Neglected',
  'opening:pawn-overextension': 'Pawn Overextension',
  'opening:wasted-tempo': 'Wasted Tempo',
  'opening:center-control': 'Center Control',

  'strategy:piece-coordination': 'Piece Coordination',
  'strategy:outpost-control': 'Outpost Control',
  'strategy:open-file-control': 'Open File Control',
  'strategy:weak-squares': 'Weak Squares',
  'strategy:isolated-pawn': 'Isolated Pawn',
  'strategy:doubled-pawns': 'Doubled Pawns',
  'strategy:king-safety-risk': 'Vulnerable King',
  'strategy:pawn-storm': 'Pawn Storm',
  'strategy:passive-defense': 'Passive Defense',
  'strategy:overextended-attack': 'Overextended Attack',

  'endgame:passed-pawn-created': 'Passed Pawn Created',
  'endgame:passed-pawn-missed': 'Allowed Passed Pawn',
  'endgame:active-rook': 'Active Rook',
  'endgame:passive-rook': 'Passive Rook',
  'endgame:king-centralization': 'Active King',
  'endgame:pawn-race': 'Pawn Race',
  'endgame:opposition': 'Opposition',
  'endgame:technical-conversion': 'Smooth Conversion',
  'endgame:stalemate-trap': 'Stalemate Resource',

  'general:time-trouble': 'Time Trouble',
  'general:resilient-defense': 'Resilient Defense',
  'general:comeback-win': 'Comeback Win',
  'general:missed-simplification': 'Missed Simplification',
};

export function getTagBadge(tag: string): TagBadgeConfig {
  const norm = tag.toLowerCase().trim();
  const label = TAG_LABELS[norm] || norm.split(':').pop()?.replace(/-/g, ' ') || norm;

  if (norm.startsWith('tactic:')) {
    const isMissed = norm.includes('missed') || norm.includes('hanging');
    return {
      label,
      bgClass: isMissed
        ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800'
        : 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800',
      textClass: isMissed
        ? 'text-rose-700 dark:text-rose-300'
        : 'text-amber-700 dark:text-amber-300',
      category: 'tactic',
    };
  }

  if (norm.startsWith('opening:')) {
    return {
      label,
      bgClass: 'bg-violet-50 dark:bg-violet-950/40 border-violet-200 dark:border-violet-800',
      textClass: 'text-violet-700 dark:text-violet-300',
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

  return {
    label,
    bgClass: 'bg-slate-100 dark:bg-slate-800 border-slate-200 dark:border-slate-700',
    textClass: 'text-slate-700 dark:text-slate-300',
    category: 'general',
  };
}
