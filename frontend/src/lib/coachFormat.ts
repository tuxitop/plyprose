import { decorateReportHtml } from './chessNav';
import type { CriticalMomentData } from '../components/InteractiveBoard';

export interface CoachPlyContext {
  ply: number;
  moveNumber: number;
  color: 'w' | 'b';
  san: string;
  criticalMoment?: CriticalMomentData;
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
    questions.push(
      `What tactical pattern or calculation motif did I miss here?`,
      `How should I calculate this position next time to avoid this?`,
    );
    return questions;
  }

  return [
    `What is the main strategic purpose of ${moveStr}?`,
    `What are the best candidate replies against ${moveStr}?`,
    `What tactical motifs should both sides watch out for here?`,
    `How should I evaluate the resulting position after ${moveStr}?`,
  ];
}

export function renderCoachAnswerHtml(markdownText: string, pgnText: string): string {
  if (!markdownText) return '';

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
