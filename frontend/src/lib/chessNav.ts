import { Chess } from 'chess.js';

function normalizeFen(fen: string): string {
  if (!fen) return '';
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/**
 * Finds the ply index (0 for start position, 1..N for moves) that matches the target FEN.
 * Returns -1 if no matching position exists in the game.
 */
export function findPlyByFen(targetFen: string, pgnText: string): number {
  if (!targetFen || !pgnText) return -1;
  const normTarget = normalizeFen(targetFen);

  const c = new Chess();
  if (normalizeFen(c.fen()) === normTarget) {
    return 0;
  }

  try {
    c.loadPgn(pgnText);
    const history = c.history({ verbose: true });

    // Check after each move
    for (let i = 0; i < history.length; i++) {
      if (normalizeFen(history[i].after) === normTarget) {
        return i + 1;
      }
    }

    // Check before each move
    for (let i = 0; i < history.length; i++) {
      if (normalizeFen(history[i].before) === normTarget) {
        return i;
      }
    }
  } catch (e) {
    console.warn('findPlyByFen error:', e);
  }

  return -1;
}

/**
 * Resolves clicked text or table cell in report HTML into a game ply (0..N).
 * Returns -1 if text cannot be mapped to a ply.
 */
export function resolveMoveTextToPly(
  text: string,
  element: HTMLElement | null,
  pgnText: string,
): number {
  if (!pgnText) return -1;
  const clean = (text || '').trim().replace(/[`*]/g, '');
  if (!clean) return -1;

  let history: ReturnType<Chess['history']>;
  try {
    const c = new Chess();
    c.loadPgn(pgnText);
    history = c.history({ verbose: true });
  } catch {
    return -1;
  }

  if (history.length === 0) return -1;

  // 1. Direct move number + SAN pattern: e.g. "14... cxd4", "14...cxd4", "14. e4"
  const fullMoveMatch = clean.match(/^(\d+)\s*(\.{1,3})\s*([A-Za-z0-9+#=-]+)?/);
  if (fullMoveMatch) {
    const moveNum = parseInt(fullMoveMatch[1], 10);
    const isBlack = fullMoveMatch[2].length > 1;
    const san = fullMoveMatch[3];

    const expectedPly = isBlack ? (moveNum - 1) * 2 + 2 : (moveNum - 1) * 2 + 1;
    if (expectedPly >= 1 && expectedPly <= history.length) {
      if (!san || history[expectedPly - 1].san.toLowerCase() === san.toLowerCase()) {
        return expectedPly;
      }
      return expectedPly;
    }
  }

  // 2. Table row detection (for Critical Moments table)
  if (element) {
    const tr = element.closest('tr');
    if (tr) {
      const cells = Array.from(tr.querySelectorAll('th, td')).map(c =>
        (c.textContent || '').trim(),
      );
      // Check if any cell has a move notation like "14..." or a ply number
      let rowPly = -1;
      for (const cellText of cells) {
        // e.g. "14..." or "14."
        const m = cellText.match(/^(\d+)\s*(\.{1,3})/);
        if (m) {
          const mNum = parseInt(m[1], 10);
          const isB = m[2].length > 1;
          rowPly = isB ? (mNum - 1) * 2 + 2 : (mNum - 1) * 2 + 1;
          break;
        }
      }

      if (rowPly >= 1 && rowPly <= history.length) {
        // If user clicked the "Best Move" cell or column, jump to the blunder position (rowPly - 1)
        // so they can see the board right before the mistake and explore the engine move!
        const colIndex = Array.from(tr.children).indexOf(element);
        const table = tr.closest('table');
        const headerCell =
          table?.querySelectorAll('th')?.[colIndex]?.textContent?.toLowerCase() || '';
        if (headerCell.includes('best') || element.textContent?.includes('Best')) {
          return rowPly - 1;
        }
        return rowPly;
      }
    }
  }

  // 3. Standalone SAN move: e.g. "cxd4", "Nf3", "O-O", "Bxf7+", "e4"
  // Clean punctuation / check / mate suffixes for matching
  const candidateSan = clean.replace(/[.,;:]/g, '');
  const matchingPlies = history
    .map((m, idx) => ({ ply: idx + 1, san: m.san }))
    .filter(m => m.san.toLowerCase() === candidateSan.toLowerCase());

  if (matchingPlies.length === 1) {
    return matchingPlies[0].ply;
  } else if (matchingPlies.length > 1 && element) {
    // If multiple occurrences of a move (e.g. "e4" or "Nf3"), check if nearby text has move number
    const parentText = element.parentElement?.textContent || '';
    const nearMoveMatch = parentText.match(/(\d+)\s*\.{1,3}/);
    if (nearMoveMatch) {
      const nearNum = parseInt(nearMoveMatch[1], 10);
      const closest = matchingPlies.find(p => Math.floor((p.ply - 1) / 2) + 1 === nearNum);
      if (closest) return closest.ply;
    }
    // Default to the first match
    return matchingPlies[0].ply;
  }

  return -1;
}
