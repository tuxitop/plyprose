import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractAnnotationsFromReportMarkdown,
  weaveReportAnnotationsIntoPgn,
  extractCommentsAndClocksFromPgn,
} from '../src/lib/pgnWriter.ts';

test('extractAnnotationsFromReportMarkdown parses single and multi-line bullets', () => {
  const report = `
### Instructive Move Annotations
- \`11... e4\`: Exploits the paralysis of the c3 knight with an unstoppable pawn fork against d3 and f3.
  While this move works, it actually overlooked the superior tactical continuation 11... Bxd3! first.
- \`13... Ne4\`: Piles maximum pressure onto the pinned c3 knight.
`;

  const map = extractAnnotationsFromReportMarkdown(report);
  assert.strictEqual(map.has('11... e4'), true);
  const e4Note = map.get('11... e4');
  assert.ok(e4Note?.includes('Exploits the paralysis of the c3 knight'));
  assert.ok(e4Note?.includes('11... Bxd3! first'));

  assert.strictEqual(map.has('13... Ne4'), true);
  assert.strictEqual(map.get('13... Ne4'), 'Piles maximum pressure onto the pinned c3 knight.');
});

test('weaveReportAnnotationsIntoPgn weaves annotations into PGN comments', () => {
  const rawPgn = `[Event "Test"]\n\n1. e4 e5 2. Nf3 Nc6 1-0`;
  const report = `
### Instructive Move Annotations
- \`1. e4\`: Establishes control over d5 and opens pathways for development.
`;

  const woven = weaveReportAnnotationsIntoPgn(rawPgn, report);
  assert.ok(woven.includes('✨ Establishes control over d5'));

  const parsed = extractCommentsAndClocksFromPgn(woven);
  assert.strictEqual(parsed.comments.has(1), true);
  assert.ok(parsed.comments.get(1)?.includes('Establishes control over d5'));
});
