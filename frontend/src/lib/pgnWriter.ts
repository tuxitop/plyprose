import { Chess } from 'chess.js';
import type { Key } from '@lichess-org/chessground/types';
import type { VariationPly } from '../components/InteractiveBoard';

export interface SavedVariation {
  id: string;
  branchPly: number; // Ply index (0..N) where this variation branches FROM
  moves: VariationPly[];
  comment?: string;
}

function parseVariationMoves(
  startFen: string,
  rawText: string,
  baseMoveNumber: number,
  baseColor: 'w' | 'b',
): VariationPly[] {
  const sim = new Chess(startFen);
  const tokens: Array<{ type: 'comment' | 'san'; text: string }> = [];
  let i = 0;
  while (i < rawText.length) {
    if (rawText[i] === '{') {
      let comment = '';
      i++;
      while (i < rawText.length && rawText[i] !== '}') {
        comment += rawText[i];
        i++;
      }
      i++;
      tokens.push({ type: 'comment', text: comment.trim() });
    } else if (/\s/.test(rawText[i])) {
      i++;
    } else {
      let word = '';
      while (
        i < rawText.length &&
        !/\s/.test(rawText[i]) &&
        rawText[i] !== '{' &&
        rawText[i] !== '}'
      ) {
        word += rawText[i];
        i++;
      }
      if (!/^\d+\.+$/.test(word) && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) {
        tokens.push({ type: 'san', text: word });
      }
    }
  }

  const moves: VariationPly[] = [];
  let currentPlyIdx = 0;
  for (const token of tokens) {
    if (token.type === 'san') {
      try {
        const moveRes = sim.move(token.text);
        if (!moveRes) break;
        const moveNumber =
          baseColor === 'b'
            ? baseMoveNumber + 1 + Math.floor(currentPlyIdx / 2)
            : baseMoveNumber + Math.floor((currentPlyIdx + 1) / 2);
        moves.push({
          plyIndex: currentPlyIdx++,
          fen: sim.fen(),
          san: moveRes.san,
          moveNumber,
          color: moveRes.color,
          from: moveRes.from as Key,
          to: moveRes.to as Key,
        });
      } catch {
        break;
      }
    } else if (token.type === 'comment' && moves.length > 0) {
      moves[moves.length - 1].comment = token.text;
    }
  }
  return moves;
}

/**
 * Extracts saved variations from PGN text (RAV notation).
 */
export function extractVariationsFromPgn(pgnText: string): SavedVariation[] {
  if (!pgnText) return [];
  const c = new Chess();
  try {
    c.loadPgn(pgnText);
  } catch {
    return [];
  }
  const history = c.history({ verbose: true });
  if (!history.length) return [];

  const fens: string[] = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'];
  for (const m of history) {
    fens.push(m.after);
  }

  const moveText = pgnText.replace(/\[[^\]]*\]/g, '').trim();
  const variations: SavedVariation[] = [];
  let currentMainlineIdx = -1;
  let inComment = false;
  let parenDepth = 0;
  let currentVarText = '';
  let currentVarBranchPly = -1;
  let varCounter = 0;

  let i = 0;
  while (i < moveText.length) {
    const ch = moveText[i];
    if (ch === '{' && parenDepth === 0) {
      inComment = true;
      i++;
      continue;
    }
    if (ch === '}' && inComment) {
      inComment = false;
      i++;
      continue;
    }
    if (inComment) {
      i++;
      continue;
    }

    if (ch === '(') {
      if (parenDepth === 0) {
        currentVarBranchPly = currentMainlineIdx;
        currentVarText = '';
      } else {
        currentVarText += ch;
      }
      parenDepth++;
      i++;
      continue;
    }

    if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        if (currentVarBranchPly >= 0 && currentVarText.trim()) {
          const branchFen = fens[currentVarBranchPly];
          const baseMoveNum =
            currentVarBranchPly === 0 ? 0 : Math.floor((currentVarBranchPly - 1) / 2) + 1;
          const baseColor =
            currentVarBranchPly === 0 ? 'b' : history[currentVarBranchPly - 1].color;
          const parsedMoves = parseVariationMoves(
            branchFen,
            currentVarText.trim(),
            baseMoveNum,
            baseColor,
          );
          if (parsedMoves.length > 0) {
            variations.push({
              id: `pgn-var-${++varCounter}`,
              branchPly: currentVarBranchPly,
              moves: parsedMoves,
            });
          }
        }
      } else {
        currentVarText += ch;
      }
      i++;
      continue;
    }

    if (parenDepth > 0) {
      currentVarText += ch;
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    let word = '';
    while (
      i < moveText.length &&
      !/\s/.test(moveText[i]) &&
      moveText[i] !== '{' &&
      moveText[i] !== '(' &&
      moveText[i] !== ')'
    ) {
      word += moveText[i];
      i++;
    }

    if (/^\d+\.+$/.test(word) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(word)) {
      continue;
    }

    if (
      currentMainlineIdx + 1 < history.length &&
      (word === history[currentMainlineIdx + 1].san ||
        word.replace(/[+#!?]/g, '') === history[currentMainlineIdx + 1].san.replace(/[+#!?]/g, ''))
    ) {
      currentMainlineIdx++;
    }
  }

  return variations;
}

/**
 * Extracts human / coach comments and clock annotations from PGN text.
 */
export function extractCommentsAndClocksFromPgn(pgnText: string): {
  comments: Map<number, string>;
  clocks: Map<number, string>;
} {
  const comments = new Map<number, string>();
  const clocks = new Map<number, string>();
  if (!pgnText) return { comments, clocks };

  try {
    const c = new Chess();
    c.loadPgn(pgnText);
    const history = c.history({ verbose: true });
    const rawComments = c.getComments();
    const commentByFen = new Map<string, string>();

    rawComments.forEach(rc => {
      if (rc.fen && rc.comment) {
        commentByFen.set(rc.fen, rc.comment.trim());
      }
    });

    history.forEach((m, idx) => {
      const plyNum = idx + 1;
      const raw = commentByFen.get(m.after);
      if (raw) {
        const clkMatch = raw.match(/\[%clk\s+[^\]]+\]/);
        if (clkMatch) {
          clocks.set(plyNum, clkMatch[0]);
        }
        const cleaned = raw.replace(/\[%(?:clk|eval)\s+[^\]]+\]/g, '').trim();
        if (cleaned) {
          comments.set(plyNum, cleaned);
        }
      }
    });
  } catch {
    // If PGN parsing fails, return empty maps
  }

  return { comments, clocks };
}

/**
 * Serializes game headers, mainline moves with comments/clocks, and variations
 * into standard PGN string complying with RFC standard.
 */
export function buildAnnotatedPgn(
  basePgn: string,
  moveComments: Map<number, string>,
  variations: SavedVariation[] = [],
): string {
  if (!basePgn) return '';

  const c = new Chess();
  try {
    c.loadPgn(basePgn);
  } catch {
    return basePgn;
  }

  const history = c.history({ verbose: true });
  if (!history.length) return basePgn;

  // Extract raw clock annotations from original PGN
  const { clocks } = extractCommentsAndClocksFromPgn(basePgn);

  // Extract headers from basePgn
  const headerLines: string[] = [];
  const lines = basePgn.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      headerLines.push(trimmed);
    } else if (trimmed && !trimmed.startsWith('[')) {
      break;
    }
  }

  const headers = headerLines.length > 0 ? headerLines.join('\n') : c.header();
  let moveText = '';

  for (let idx = 0; idx < history.length; idx++) {
    const ply = idx + 1;
    const m = history[idx];
    const isWhite = m.color === 'w';
    const moveNum = Math.floor(idx / 2) + 1;

    if (isWhite) {
      moveText += `${moveNum}. ${m.san}`;
    } else {
      // Black move
      if (idx === 0 || moveText.endsWith(') ') || moveText.endsWith('}\n')) {
        moveText += `${moveNum}... ${m.san}`;
      } else {
        moveText += ` ${m.san}`;
      }
    }

    // Attach comments & clocks
    const comment = moveComments.get(ply);
    const clock = clocks.get(ply);
    const parts: string[] = [];
    if (clock) parts.push(clock);
    if (comment) parts.push(comment.trim());

    if (parts.length > 0) {
      moveText += ` { ${parts.join(' ')} }`;
    }

    moveText += ' ';

    // Attach variations branching from this position (idx = branchPly, replacing move at idx)
    // In PGN RAV standard, an alternative to history[idx] appears immediately after history[idx].
    const varsAtThisPly = variations.filter(v => v.branchPly === idx && v.moves.length > 0);
    for (const v of varsAtThisPly) {
      moveText += '( ';
      for (let vIdx = 0; vIdx < v.moves.length; vIdx++) {
        const vm = v.moves[vIdx];
        if (vm.color === 'w') {
          moveText += `${vm.moveNumber}. ${vm.san}`;
        } else if (vIdx === 0) {
          moveText += `${vm.moveNumber}... ${vm.san}`;
        } else {
          moveText += ` ${vm.san}`;
        }
        if (vm.comment) {
          moveText += ` { ${vm.comment.trim()} }`;
        }
        moveText += ' ';
      }
      moveText += ') ';
    }
  }

  // Append result if present in headers
  const resultMatch = basePgn.match(/\b(1-0|0-1|1\/2-1\/2|\*)\s*$/);
  const resultStr = resultMatch ? resultMatch[1] : '*';

  return `${typeof headers === 'string' ? headers : ''}\n\n${moveText.trim()} ${resultStr}`.trim();
}

/**
 * Extracts move-specific upfront annotations from coaching report Markdown.
 * Supports multi-line bullets / paragraphs.
 */
export function extractAnnotationsFromReportMarkdown(reportMd: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!reportMd) return map;

  const bulletRe = /^[ \t]*-[ \t]*`([0-9]+\.{1,3}\s*[A-Za-z0-9+#=-]+)`:[ \t]*(.*)$/;
  const lines = reportMd.split('\n');
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(bulletRe);
    if (m) {
      const moveKey = m[1].trim();
      const parts: string[] = m[2].trim() ? [m[2].trim()] : [];
      i++;
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (bulletRe.test(line) || trimmed.startsWith('#')) break;
        if (!trimmed) {
          const nxt = lines.slice(i + 1).find(l => l.trim());
          if (
            nxt &&
            (bulletRe.test(nxt) || nxt.trim().startsWith('#') || nxt.trim().startsWith(':::'))
          ) {
            break;
          }
          i++;
          continue;
        }
        parts.push(trimmed);
        i++;
      }
      const fullComment = parts
        .join(' ')
        .replace(/^["'*]+|["'*]+$/g, '')
        .trim();
      if (moveKey && fullComment) {
        const normKey = moveKey.replace(/([0-9]+(?:\.{1,3}))\s*/, '$1 ');
        map.set(normKey, fullComment);
        map.set(moveKey, fullComment);
      }
    } else {
      i++;
    }
  }

  return map;
}

/**
 * Weaves upfront report annotations into PGN string if they are not already present.
 */
export function weaveReportAnnotationsIntoPgn(pgnText: string, reportMd?: string): string {
  if (!pgnText || !reportMd || pgnText.includes('✨')) return pgnText;
  const annMap = extractAnnotationsFromReportMarkdown(reportMd);
  if (annMap.size === 0) return pgnText;

  const c = new Chess();
  try {
    c.loadPgn(pgnText);
  } catch {
    return pgnText;
  }
  const history = c.history({ verbose: true });
  if (!history.length) return pgnText;

  const { comments } = extractCommentsAndClocksFromPgn(pgnText);
  const variations = extractVariationsFromPgn(pgnText);

  let added = false;
  history.forEach((m, idx) => {
    const ply = idx + 1;
    const moveNum = Math.floor(idx / 2) + 1;
    const isBlack = m.color === 'b';
    const keySpaced = isBlack ? `${moveNum}... ${m.san}` : `${moveNum}. ${m.san}`;
    const keyTight = isBlack ? `${moveNum}...${m.san}` : `${moveNum}.${m.san}`;
    const comment = annMap.get(keySpaced) || annMap.get(keyTight);
    if (comment) {
      const cleanComment = comment.startsWith('✨') ? comment : `✨ ${comment}`;
      const existing = comments.get(ply) || '';
      if (!existing.includes(cleanComment)) {
        comments.set(ply, existing ? `${existing} ${cleanComment}` : cleanComment);
        added = true;
      }
    }
  });

  if (!added) return pgnText;
  return buildAnnotatedPgn(pgnText, comments, variations);
}
