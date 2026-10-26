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
