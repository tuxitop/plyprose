import { decorateReportHtml } from './chessNav';
import type { CriticalMomentData } from '../components/InteractiveBoard';

export interface CoachPlyContext {
  ply: number;
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  criticalMoment?: CriticalMomentData;
  timeSpentSeconds?: number | null;
  clockSecondsRemaining?: number | null;
}

export function getQuickQuestions(plyData?: CoachPlyContext): string[] {
  if (!plyData || plyData.ply === 0) {
    return [
      'What is the key strategic idea in this opening position?',
      'What are the primary candidate plans for both sides?',
      'What pawn structures and weaknesses should I keep in mind?',
      'How should I calculate candidate moves from this starting position?',
    ];
  }

  const moveStr = `${plyData.moveNumber}.${plyData.color === 'b' ? '.. ' : ' '}${plyData.san}`;
  const cm = plyData.criticalMoment;

  if (cm) {
    const classification = cm.classification || 'Mistake';
    const bestMove = cm.best_move_san
      ? `${cm.move_number}.${plyData.color === 'b' ? '.. ' : ' '}${cm.best_move_san}`
      : null;
    const questions: string[] = [`Why is ${moveStr} considered a ${classification.toLowerCase()}?`];
    if (bestMove) {
      questions.push(`Why is ${bestMove} better than ${moveStr}?`);
    }
    if (
      cm.time_spent_seconds !== null &&
      cm.time_spent_seconds !== undefined &&
      cm.time_spent_seconds < 3.0
    ) {
      questions.push(`Did rushing this move in ${cm.time_spent_seconds}s lead to this error?`);
    } else if (
      cm.clock_seconds_remaining !== null &&
      cm.clock_seconds_remaining !== undefined &&
      cm.clock_seconds_remaining <= 30.0
    ) {
      questions.push(`How should I better handle the clock and time pressure here?`);
    } else if (
      cm.time_spent_seconds !== null &&
      cm.time_spent_seconds !== undefined &&
      cm.time_spent_seconds > 45.0
    ) {
      questions.push(`Was spending ${cm.time_spent_seconds}s on this move necessary?`);
    }
    questions.push(
      `What tactical pattern or calculation motif applies here?`,
      `How should I calculate this position next time to avoid this?`,
    );
    return questions.slice(0, 4);
  }

  return [
    `What is the main strategic purpose of ${moveStr}?`,
    `What are the best candidate replies against ${moveStr}?`,
    `What tactical motifs should both sides watch out for here?`,
    `How should I evaluate the resulting position after ${moveStr}?`,
  ];
}

export function getDeterministicMoveExplanation(plyData?: CoachPlyContext): string {
  if (!plyData || plyData.ply === 0) {
    return [
      '- **Starting Position:** Both sides have standard opening options available.',
      '- **Recommended Play:** Control the center with classical pawn breaks (`1. e4`, `1. d4`, `1. Nf3`, `1. c4`), develop your knights and bishops toward active squares, and secure kingside castling.',
    ].join('\n\n');
  }

  const dot = plyData.color === 'b' ? '...' : '.';
  const moveStr = `${plyData.moveNumber}${dot} ${plyData.san}`;
  const cm = plyData.criticalMoment;

  if (cm) {
    const lines: string[] = [];
    const classification = cm.classification || 'Mistake';
    const beforeEval =
      cm.eval_before_cp !== undefined && cm.eval_before_cp !== null
        ? `${cm.eval_before_cp >= 0 ? '+' : ''}${(cm.eval_before_cp / 100).toFixed(2)}`
        : cm.mate_before
          ? `M${cm.mate_before > 0 ? '+' : ''}${cm.mate_before}`
          : 'even';
    const afterEval =
      cm.eval_after_cp !== undefined && cm.eval_after_cp !== null
        ? `${cm.eval_after_cp >= 0 ? '+' : ''}${(cm.eval_after_cp / 100).toFixed(2)}`
        : cm.mate_after
          ? `M${cm.mate_after > 0 ? '+' : ''}${cm.mate_after}`
          : 'even';

    lines.push(
      `- **Tactical Reality of the Move:** You played \`${moveStr}\`, shifting the engine evaluation from \`${beforeEval}\` to \`${afterEval}\` (${classification}).`,
    );

    if (cm.best_move_san) {
      const bestMoveStr = `${cm.move_number}${dot} ${cm.best_move_san}`;
      const pvContinuation =
        cm.pv_san && cm.pv_san.length > 0
          ? ` (continuation: \`${cm.pv_san.slice(0, 4).join(' ')}\`)`
          : '';
      lines.push(
        `- **The Recommended Alternative:** Stockfish prefers \`${bestMoveStr}\`${pvContinuation}.`,
      );
    }

    if (cm.refutation_san && cm.refutation_san.length > 0) {
      lines.push(
        `- **Opponent's Tactical Punishment:** The played move allowed the opponent to respond with \`${cm.refutation_san.slice(0, 3).join(' ')}\`, seizing the tactical advantage.`,
      );
    }

    if (
      cm.time_spent_seconds !== null &&
      cm.time_spent_seconds !== undefined &&
      cm.time_spent_seconds < 3.0
    ) {
      lines.push(
        `- **Clock Management:** Rushed in just ${cm.time_spent_seconds}s. Critical tactical decisions warrant calculating candidate replies before moving.`,
      );
    } else if (
      cm.clock_seconds_remaining !== null &&
      cm.clock_seconds_remaining !== undefined &&
      cm.clock_seconds_remaining <= 30.0
    ) {
      lines.push(
        `- **Time Pressure Context:** Only ${Math.round(cm.clock_seconds_remaining)}s left on the clock. In severe time pressure, prioritize active piece coordination and king safety.`,
      );
    }

    if (cm.facts_before_move?.hanging_pieces && cm.facts_before_move.hanging_pieces.length > 0) {
      lines.push(
        `- **Hanging Pieces Before Move:** ${cm.facts_before_move.hanging_pieces.join(', ')}.`,
      );
    }
    if (
      cm.facts_after_played_move?.hanging_pieces &&
      cm.facts_after_played_move.hanging_pieces.length > 0
    ) {
      lines.push(
        `- **Hanging Pieces Created After Move:** ${cm.facts_after_played_move.hanging_pieces.join(', ')}.`,
      );
    }

    const tagsLower = (cm.tags || []).map(t => t.toLowerCase());
    if (tagsLower.some(t => t.includes('hang') || t.includes('free'))) {
      lines.push(
        '- **Key Principle for Next Time:** Check all undefended pieces ("Loose Pieces Drop Off") before committing to any tactical trades or pawn breaks.',
      );
    } else if (tagsLower.some(t => t.includes('pin'))) {
      lines.push(
        '- **Key Principle for Next Time:** Pins paralyze pieces. Never assume a pinned piece is adequately defending another square.',
      );
    } else if (tagsLower.some(t => t.includes('fork'))) {
      lines.push(
        '- **Key Principle for Next Time:** Look for dual-threat geometries where two uncoordinated targets can be attacked simultaneously.',
      );
    } else if (tagsLower.some(t => t.includes('time') || t.includes('rushed'))) {
      lines.push(
        '- **Key Principle for Next Time:** When the position enters high tactical tension, invest time to verify at least one candidate opponent reply.',
      );
    } else {
      lines.push(
        '- **Key Principle for Next Time:** When calculating under tactical tension, look to resolve threats against your own pieces first and calculate forcing checks and captures before committing.',
      );
    }

    return lines.join('\n\n');
  }

  const lines: string[] = [
    `- **Move Overview:** Played \`${moveStr}\`.`,
    '- **Position Assessment:** Solid mainline move maintaining the balance. No tactical errors or missed wins detected.',
  ];
  if (plyData.timeSpentSeconds !== undefined && plyData.timeSpentSeconds !== null) {
    lines.push(`- **Time Spent:** ${plyData.timeSpentSeconds}s.`);
  }
  return lines.join('\n\n');
}

export function renderCoachAnswerHtml(markdownText: string, pgnText: string): string {
  if (!markdownText) return '';

  try {
    const lines = markdownText.split('\n');
    const htmlParts: string[] = [];
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        if (inList) {
          htmlParts.push('</ul>');
          inList = false;
        }
        continue;
      }

      // List item
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        if (!inList) {
          htmlParts.push(
            '<ul class="list-disc list-inside space-y-1 my-2 text-slate-700 dark:text-slate-300">',
          );
          inList = true;
        }
        const itemContent = formatInlineMarkdown(trimmed.slice(2));
        htmlParts.push(`<li>${itemContent}</li>`);
        continue;
      }

      if (inList) {
        htmlParts.push('</ul>');
        inList = false;
      }

      // Headings
      if (trimmed.startsWith('#### ')) {
        htmlParts.push(
          `<h5 class="text-xs font-semibold text-slate-800 dark:text-slate-200 mt-2 mb-1">${formatInlineMarkdown(trimmed.slice(5))}</h5>`,
        );
      } else if (trimmed.startsWith('### ')) {
        htmlParts.push(
          `<h4 class="text-xs font-bold text-slate-900 dark:text-slate-100 mt-3 mb-1.5">${formatInlineMarkdown(trimmed.slice(4))}</h4>`,
        );
      } else if (trimmed.startsWith('## ')) {
        htmlParts.push(
          `<h3 class="text-sm font-bold text-blue-700 dark:text-blue-400 mt-3 mb-1.5">${formatInlineMarkdown(trimmed.slice(3))}</h3>`,
        );
      } else if (trimmed.startsWith('# ')) {
        htmlParts.push(
          `<h2 class="text-base font-bold text-slate-900 dark:text-slate-100 mt-4 mb-2">${formatInlineMarkdown(trimmed.slice(2))}</h2>`,
        );
      } else {
        // Paragraph
        htmlParts.push(
          `<p class="my-1.5 leading-relaxed text-slate-700 dark:text-slate-300">${formatInlineMarkdown(trimmed)}</p>`,
        );
      }
    }

    if (inList) {
      htmlParts.push('</ul>');
    }

    const rawHtml = htmlParts.join('\n');
    return decorateReportHtml(rawHtml, pgnText);
  } catch (err) {
    console.warn('Failed to decorate coach answer HTML:', err);
    return markdownText;
  }
}

function formatInlineMarkdown(text: string): string {
  let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Bold **text**
  s = s.replace(
    /\*\*(.*?)\*\*/g,
    '<strong class="font-semibold text-slate-900 dark:text-slate-100">$1</strong>',
  );
  // Italic *text*
  s = s.replace(/\*(.*?)\*/g, '<em class="italic">$1</em>');
  // Inline code `code`
  s = s.replace(
    /`([^`]+)`/g,
    '<code class="px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono font-semibold">$1</code>',
  );

  return s;
}
