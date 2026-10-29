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

export interface MoveNavTarget {
  type: 'mainline' | 'variation';
  ply: number; // For mainline: target game ply (1..N). For variation: branchPly (position before the move)
  variationMoves?: string[]; // Sanitized moves to play in the variation
  displaySan: string;
}

function cleanSan(s: string): string {
  return (s || '').replace(/[!?]/g, '').trim();
}

/**
 * Splits text into move tokens, extracting any leading move number and color.
 * e.g. "37. Nxc3! exf4+" -> { moveNum: 37, isBlack: false, moves: ["Nxc3!", "exf4+"] }
 * e.g. "36... e5?!" -> { moveNum: 36, isBlack: true, moves: ["e5?!"] }
 */
function parseMoveTokens(text: string): {
  moveNum: number | null;
  isBlack: boolean;
  moves: string[];
} {
  const clean = text.trim().replace(/[`*]/g, '');
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { moveNum: null, isBlack: false, moves: [] };

  let moveNum: number | null = null;
  let isBlack = false;
  const moves: string[] = [];

  const first = tokens[0];
  const numMatch = first.match(/^(\d+)\s*(\.{1,3})(.*)$/);
  let startIndex = 0;

  if (numMatch) {
    moveNum = parseInt(numMatch[1], 10);
    isBlack = numMatch[2].length > 1;
    const remainder = numMatch[3].trim();
    startIndex = 1;
    if (remainder) {
      moves.push(remainder);
    }
  }

  for (let i = startIndex; i < tokens.length; i++) {
    const t = tokens[i];
    const innerNum = t.match(/^(\d+)\s*(\.{1,3})(.*)$/);
    if (innerNum) {
      if (innerNum[3].trim()) {
        moves.push(innerNum[3].trim());
      }
    } else {
      moves.push(t);
    }
  }

  return { moveNum, isBlack, moves };
}

/**
 * Classifies a move text string against game PGN.
 * Accurately determines if it is a mainline game move or an alternative variation.
 */
export function classifyReportMove(
  text: string,
  pgnText: string,
  contextElement?: HTMLElement | null,
): MoveNavTarget | null {
  if (!text || !pgnText) return null;
  const clean = text.trim().replace(/[`*]/g, '');
  // Ignore FENs, URLs, or non-chess text
  if (clean.includes('/') || clean.length < 2 || clean.includes('http')) return null;

  let history: ReturnType<Chess['history']>;
  try {
    const c = new Chess();
    c.loadPgn(pgnText);
    history = c.history({ verbose: true });
  } catch {
    return null;
  }
  if (!history || history.length === 0) return null;

  const parsed = parseMoveTokens(clean);
  let moveNum = parsed.moveNum;
  let isBlack = parsed.isBlack;
  const rawMoves = parsed.moves;

  // If move number was not in the text, check contextElement (e.g. table row)
  if (moveNum === null && contextElement) {
    const tr = contextElement.closest('tr');
    if (tr) {
      const cells = Array.from(tr.querySelectorAll('th, td')).map(el =>
        (el.textContent || '').trim(),
      );
      for (const cell of cells) {
        const m = cell.match(/^(\d+)\s*(\.{1,3})/);
        if (m) {
          moveNum = parseInt(m[1], 10);
          isBlack = m[2].length > 1;
          break;
        }
      }
    }
  }

  // 1. With move number:
  if (moveNum !== null) {
    const gamePly = isBlack ? (moveNum - 1) * 2 + 2 : (moveNum - 1) * 2 + 1;
    const branchPly = gamePly - 1;

    // Check if first move matches the played mainline move
    if (gamePly >= 1 && gamePly <= history.length) {
      const playedSan = history[gamePly - 1].san;
      const firstRaw = rawMoves[0] || '';
      const firstSan = cleanSan(firstRaw);

      if (!firstSan || playedSan.toLowerCase() === firstSan.toLowerCase()) {
        return {
          type: 'mainline',
          ply: gamePly,
          displaySan: `${moveNum}.${isBlack ? '..' : ''} ${playedSan}`,
        };
      }
    }

    // Does not match played move: test if it is a valid alternative variation from branchPly!
    if (branchPly >= 0 && branchPly <= history.length && rawMoves.length > 0) {
      const branchFen = branchPly === 0 ? new Chess().fen() : history[branchPly - 1].after;
      const sim = new Chess(branchFen);
      const validMoves: string[] = [];

      for (const rm of rawMoves) {
        const s = cleanSan(rm);
        try {
          const res = sim.move(s);
          if (res) {
            validMoves.push(res.san);
          } else {
            const res2 = sim.move(s.replace(/[+#]/g, ''));
            if (res2) validMoves.push(res2.san);
            else break;
          }
        } catch {
          break;
        }
      }

      if (validMoves.length > 0) {
        return {
          type: 'variation',
          ply: branchPly,
          variationMoves: validMoves,
          displaySan: `${moveNum}.${isBlack ? '..' : ''} ${validMoves[0]}`,
        };
      }
    }
  }

  // 2. Standalone SAN move without move number (e.g. "cxd4", "Nf3")
  if (rawMoves.length > 0) {
    const candidate = cleanSan(rawMoves[0]).replace(/[.,;:]/g, '');
    if (!candidate) return null;

    const matches = history
      .map((m, idx) => ({
        ply: idx + 1,
        san: m.san,
        moveNumber: Math.floor(idx / 2) + 1,
        color: m.color,
      }))
      .filter(m => m.san.toLowerCase() === candidate.toLowerCase());

    if (matches.length === 1) {
      return {
        type: 'mainline',
        ply: matches[0].ply,
        displaySan: `${matches[0].moveNumber}.${matches[0].color === 'b' ? '..' : ''} ${matches[0].san}`,
      };
    }
  }

  return null;
}

/**
 * Decorates report HTML to visually distinguish played moves from variations
 * and make all moves interactive with clean accessible button markup.
 */
export function decorateReportHtml(html: string, pgnText: string): string {
  if (!html || !pgnText) return html;

  return html.replace(/<code([^>]*)>([\s\S]*?)<\/code>/gi, (match, _attrs, content) => {
    const rawText = content.replace(/<[^>]+>/g, '').trim();
    if (!rawText || rawText.includes('/') || rawText.length < 2) {
      return match;
    }

    const target = classifyReportMove(rawText, pgnText);
    if (!target) {
      return match;
    }

    if (target.type === 'mainline') {
      return `<button type="button" class="chess-move-btn chess-move-mainline group inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded border border-blue-200 dark:border-blue-800/80 bg-blue-50/90 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/60 hover:border-blue-300 dark:hover:border-blue-700 transition-colors cursor-pointer select-none text-[12px] font-mono font-semibold align-baseline" data-move-type="mainline" data-ply="${target.ply}" title="Jump to game move ${target.displaySan}"><span class="text-[9px] text-blue-500 opacity-75 group-hover:opacity-100">▶</span>${content}</button>`;
    } else {
      const movesJson = encodeURIComponent(JSON.stringify(target.variationMoves || []));
      const branchMoveNumber = Math.floor((target.ply - 1) / 2) + 1;
      return `<button type="button" class="chess-move-btn chess-move-variation group inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded border border-dashed border-purple-300 dark:border-purple-800/80 bg-purple-50/90 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/60 hover:border-purple-400 dark:hover:border-purple-600 transition-colors cursor-pointer select-none text-[12px] font-mono font-semibold align-baseline" data-move-type="variation" data-branch-ply="${target.ply}" data-moves="${movesJson}" title="Explore variation: ${rawText} (branches at move ${branchMoveNumber})"><span class="text-[10px] text-purple-500 font-bold opacity-80 group-hover:opacity-100">⑂</span>${content}</button>`;
    }
  });
}

/**
 * Resolves clicked text or table cell in report HTML into a game ply (0..N).
 * Kept for backward compatibility.
 */
export function resolveMoveTextToPly(
  text: string,
  element: HTMLElement | null,
  pgnText: string,
): number {
  const target = classifyReportMove(text, pgnText, element);
  return target ? target.ply : -1;
}
