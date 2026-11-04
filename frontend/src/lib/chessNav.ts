import { Chess } from 'chess.js';

function normalizeFen(fen: string): string {
  if (!fen) return '';
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/**
 * Normalizes unicode chess characters, dashes, ellipsis, spaces, and punctuation.
 */
export function normalizeChessText(text: string): string {
  let clean = (text || '')
    .trim()
    .replace(/[`*]/g, '')
    // Normalize unicode dashes / hyphens to standard ASCII hyphen
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    // Normalize unicode ellipsis to three dots
    .replace(/\u2026/g, '...')
    // Normalize non-breaking and thin spaces to standard space
    .replace(/[\u00A0\u202F\u2000-\u200B]/g, ' ')
    // Strip enclosing parentheses, brackets, quotes, or trailing punctuation
    .replace(/^[([{'"><]+|[)\]}'>",;.]+$/g, '')
    .trim();

  // Normalize castling notation using 0 instead of O
  clean = clean.replace(/\b0-0-0\b/g, 'O-O-O').replace(/\b0-0\b/g, 'O-O');
  return clean;
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
  ply: number; // For mainline: target game ply at END of sequence (1..N). For variation: branchPly
  variationMoves?: string[]; // Sanitized moves to play in the variation
  displaySan: string;
}

function cleanSan(s: string): string {
  return normalizeChessText(s).replace(/[!?]/g, '').trim();
}

/**
 * Splits text into move tokens, extracting any leading move number and color.
 * Robust to unicode ellipsis (4…), separated numbers/dots (4 ...), and inner moves.
 * e.g. "37. Nxc3! exf4+" -> { moveNum: 37, isBlack: false, moves: ["Nxc3!", "exf4+"] }
 * e.g. "4… Nc6 5. Bb5" -> { moveNum: 4, isBlack: true, moves: ["Nc6", "Bb5"] }
 */
export function parseMoveTokens(text: string): {
  moveNum: number | null;
  isBlack: boolean;
  moves: string[];
} {
  const clean = normalizeChessText(text);
  const rawTokens = clean.split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return { moveNum: null, isBlack: false, moves: [] };

  // Combine separated digits and dot tokens: e.g. ["4", "...", "Nc6"] => ["4...", "Nc6"]
  const tokens: string[] = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const cur = rawTokens[i];
    const next = rawTokens[i + 1];
    if (/^\d+$/.test(cur) && next && /^(\.{1,3})$/.test(next)) {
      tokens.push(cur + next);
      i++;
    } else {
      tokens.push(cur);
    }
  }

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
      // Skip isolated move numbers or dots
      if (!/^\d+\.?$/.test(t) && !/^\.+$/.test(t)) {
        moves.push(t);
      }
    }
  }

  return { moveNum, isBlack, moves };
}

export interface TableRowContext {
  moveNum: number;
  isBlack: boolean;
}

/**
 * Extracts move number and color context from an HTML table row (DOM element or string).
 */
export function extractTableRowContext(
  contextElementOrHtml: HTMLElement | string,
): TableRowContext | null {
  if (typeof contextElementOrHtml !== 'string') {
    const tr = contextElementOrHtml.closest('tr');
    if (!tr) return null;
    const cells = Array.from(tr.querySelectorAll('th, td')).map(el =>
      (el.textContent || '').trim(),
    );
    let moveNum: number | null = null;
    let isBlack = false;

    for (const cell of cells) {
      const m = cell.match(/^(\d+)(\s*(\.{1,3}))?$/);
      if (m) {
        moveNum = parseInt(m[1], 10);
        if (m[3] && m[3].length > 1) {
          isBlack = true;
        }
        break;
      }
    }

    if (moveNum !== null) {
      for (const cell of cells) {
        if (/^black$/i.test(cell)) isBlack = true;
        if (/^white$/i.test(cell)) isBlack = false;
      }
      return { moveNum, isBlack };
    }
    return null;
  }

  // String HTML snippet representing a table row
  const trContent = contextElementOrHtml;
  const cellMatches = Array.from(trContent.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(m =>
    m[1].replace(/<[^>]+>/g, '').trim(),
  );

  let moveNum: number | null = null;
  let isBlack = false;

  for (const cell of cellMatches) {
    const m = cell.match(/^(\d+)(\s*(\.{1,3}))?$/);
    if (m) {
      moveNum = parseInt(m[1], 10);
      if (m[3] && m[3].length > 1) {
        isBlack = true;
      }
      break;
    }
  }

  if (moveNum !== null) {
    for (const cell of cellMatches) {
      if (/^black$/i.test(cell)) isBlack = true;
      if (/^white$/i.test(cell)) isBlack = false;
    }
    return { moveNum, isBlack };
  }

  return null;
}

/**
 * Classifies a move text string against game PGN.
 * Accurately determines if it is a mainline game move (or sequence) or an alternative variation.
 * When clicking a move sequence, navigates to the END of that sequence.
 */
export function classifyReportMove(
  text: string,
  pgnText: string,
  contextElement?: HTMLElement | null,
  fallbackRowContext?: TableRowContext | null,
): MoveNavTarget | null {
  if (!text || !pgnText) return null;
  const clean = normalizeChessText(text);
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

  // If move number was not in the text, check DOM contextElement (e.g. table row)
  if (moveNum === null && contextElement) {
    const trCtx = extractTableRowContext(contextElement);
    if (trCtx) {
      moveNum = trCtx.moveNum;
      isBlack = trCtx.isBlack;
    }
  }

  // If still null, check fallbackRowContext from HTML decoration
  if (moveNum === null && fallbackRowContext) {
    moveNum = fallbackRowContext.moveNum;
    isBlack = fallbackRowContext.isBlack;
  }

  // 1. With move number:
  if (moveNum !== null && rawMoves.length > 0) {
    const startPly = isBlack ? (moveNum - 1) * 2 + 2 : (moveNum - 1) * 2 + 1;
    const branchPly = startPly - 1;

    // Check how many moves match the mainline game moves
    let matchedMainlineCount = 0;
    for (let i = 0; i < rawMoves.length; i++) {
      const plyIndex = startPly + i;
      if (plyIndex <= history.length) {
        const playedSan = history[plyIndex - 1].san;
        const candSan = cleanSan(rawMoves[i]);
        if (
          playedSan.toLowerCase().replace(/[+#]/g, '') ===
          candSan.toLowerCase().replace(/[+#]/g, '')
        ) {
          matchedMainlineCount++;
          continue;
        }
      }
      break;
    }

    // Entire sequence was played in the mainline game: show the END of the sequence
    if (matchedMainlineCount === rawMoves.length) {
      const endPly = startPly + rawMoves.length - 1;
      const endMoveNum = Math.floor((endPly - 1) / 2) + 1;
      const endIsBlack = endPly % 2 === 0;
      const endSan = history[endPly - 1].san;
      return {
        type: 'mainline',
        ply: endPly,
        displaySan: `${endMoveNum}.${endIsBlack ? '..' : ''} ${endSan}`,
      };
    }

    // If the sequence partially matched mainline, then diverged into an alternative variation
    if (matchedMainlineCount > 0) {
      const divBranchPly = startPly + matchedMainlineCount - 1;
      const branchFen = divBranchPly === 0 ? new Chess().fen() : history[divBranchPly - 1].after;
      const sim = new Chess(branchFen);
      const remainingMoves = rawMoves.slice(matchedMainlineCount);
      const validMoves: string[] = [];
      for (const rm of remainingMoves) {
        const s = cleanSan(rm);
        try {
          const res = sim.move(s) || sim.move(s.replace(/[+#]/g, ''));
          if (res) validMoves.push(res.san);
          else break;
        } catch {
          break;
        }
      }
      if (validMoves.length > 0) {
        return {
          type: 'variation',
          ply: divBranchPly,
          variationMoves: validMoves,
          displaySan: `${rawMoves[0]} (var)`,
        };
      }
    }

    // Sequence did not match mainline at all: test if valid variation from branchPly
    if (branchPly >= 0 && branchPly <= history.length) {
      const branchFen = branchPly === 0 ? new Chess().fen() : history[branchPly - 1].after;
      const sim = new Chess(branchFen);
      const validMoves: string[] = [];
      for (const rm of rawMoves) {
        const s = cleanSan(rm);
        try {
          const res = sim.move(s) || sim.move(s.replace(/[+#]/g, ''));
          if (res) validMoves.push(res.san);
          else break;
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

  // 2. Standalone moves without move number (e.g. "Nc3", "cxd4", "Nf3")
  if (rawMoves.length > 0) {
    const candidate = cleanSan(rawMoves[0]);
    if (!candidate) return null;

    // Reject bare chessboard squares like "e5", "d4", "c3" without move number
    if (/^[a-h][1-8]$/i.test(candidate) && rawMoves.length === 1) {
      return null;
    }

    // Check matches against game history
    const matches = history
      .map((m, idx) => ({
        ply: idx + 1,
        san: m.san,
        moveNumber: Math.floor(idx / 2) + 1,
        color: m.color,
      }))
      .filter(
        m =>
          m.san.toLowerCase().replace(/[+#]/g, '') === candidate.toLowerCase().replace(/[+#]/g, ''),
      );

    if (matches.length > 0) {
      // If multiple moves in sequence without move numbers: check if contiguous sequence exists in history
      if (rawMoves.length > 1) {
        for (const match of matches) {
          let allMatch = true;
          for (let k = 0; k < rawMoves.length; k++) {
            const plyK = match.ply + k;
            if (plyK > history.length) {
              allMatch = false;
              break;
            }
            const expected = history[plyK - 1].san.toLowerCase().replace(/[+#]/g, '');
            const actual = cleanSan(rawMoves[k]).toLowerCase().replace(/[+#]/g, '');
            if (expected !== actual) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) {
            const endPly = match.ply + rawMoves.length - 1;
            const endMoveNum = Math.floor((endPly - 1) / 2) + 1;
            const endIsBlack = endPly % 2 === 0;
            return {
              type: 'mainline',
              ply: endPly,
              displaySan: `${endMoveNum}.${endIsBlack ? '..' : ''} ${history[endPly - 1].san}`,
            };
          }
        }
      }

      // Single move match: use first occurrence (e.g. opening move for "Nc3")
      const m = matches[0];
      return {
        type: 'mainline',
        ply: m.ply,
        displaySan: `${m.moveNumber}.${m.color === 'b' ? '..' : ''} ${m.san}`,
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

  return html.replace(/<code([^>]*)>([\s\S]*?)<\/code>/gi, (match, _attrs, content, offset) => {
    const rawText = content.replace(/<[^>]+>/g, '').trim();
    if (!rawText || rawText.includes('/') || rawText.length < 2) {
      return match;
    }

    // Check if this <code> is within a table row <tr> to supply move number context
    let fallbackRowContext: TableRowContext | null = null;
    const lastTr = html.lastIndexOf('<tr', offset);
    const lastTrClose = html.lastIndexOf('</tr>', offset);
    if (lastTr !== -1 && lastTr > lastTrClose) {
      const endTr = html.indexOf('</tr>', offset);
      const trSnippet = html.substring(lastTr, endTr !== -1 ? endTr : offset);
      fallbackRowContext = extractTableRowContext(trSnippet);
    }

    const target = classifyReportMove(rawText, pgnText, null, fallbackRowContext);
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
