import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractAnnotationsFromReportMarkdown,
  weaveReportAnnotationsIntoPgn,
  extractCommentsAndClocksFromPgn,
  buildAnnotatedPgn,
  extractVariationsFromPgn,
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

test('buildAnnotatedPgn and extractVariationsFromPgn support variations after the final move of the game', () => {
  const basePgn = `[Event "Short Game"]\n\n1. e4 e5 2. Nf3 Nc6 0-1`;
  // Game has 4 plies (1. e4, 1... e5, 2. Nf3, 2... Nc6).
  // User adds continuation after 2... Nc6 (branchPly = 4, White move 3. Bb5 a6).
  const continuationVars = [
    {
      id: 'end-var-1',
      branchPly: 4,
      moves: [
        {
          plyIndex: 0,
          fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3',
          san: 'Bb5',
          moveNumber: 3,
          color: 'w' as const,
          from: 'f1' as const,
          to: 'b5' as const,
          comment: 'Exploring what could happen next',
        },
        {
          plyIndex: 1,
          fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
          san: 'a6',
          moveNumber: 3,
          color: 'b' as const,
          from: 'a7' as const,
          to: 'a6' as const,
        },
      ],
    },
  ];

  const emptyComments = new Map<number, string>();
  const annotated = buildAnnotatedPgn(basePgn, emptyComments, continuationVars);

  assert.ok(annotated.includes('( 3. Bb5 { Exploring what could happen next } a6 )'));
  assert.ok(annotated.endsWith('0-1'));

  // Parse back to confirm round-trip extraction
  const extracted = extractVariationsFromPgn(annotated);
  assert.strictEqual(extracted.length, 1);
  assert.strictEqual(extracted[0].branchPly, 4);
  assert.strictEqual(extracted[0].moves.length, 2);
  assert.strictEqual(extracted[0].moves[0].san, 'Bb5');
  assert.strictEqual(extracted[0].moves[0].moveNumber, 3);
  assert.strictEqual(extracted[0].moves[0].color, 'w');
  assert.strictEqual(extracted[0].moves[0].comment, 'Exploring what could happen next');
  assert.strictEqual(extracted[0].moves[1].san, 'a6');
  assert.strictEqual(extracted[0].moves[1].moveNumber, 3);
  assert.strictEqual(extracted[0].moves[1].color, 'b');
});

test('buildAnnotatedPgn and extractVariationsFromPgn support final move variations with root ply (e.g. 29... Qxd5+ 30. Ke3)', () => {
  const basePgn = `[Event "Final Move Test"]\n\n1. e4 e5 2. Nf3 Nc6 0-1`;
  // Move 2... Nc6 is ply 4.
  // Variation attached to final move branches at ply 3 (before 2... Nc6) and includes 2... Nc6 as root:
  const finalMoveVars = [
    {
      id: 'final-move-var-1',
      branchPly: 3,
      moves: [
        {
          plyIndex: 0,
          fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 1 3',
          san: 'Nc6',
          moveNumber: 2,
          color: 'b' as const,
          from: 'b8' as const,
          to: 'c6' as const,
        },
        {
          plyIndex: 1,
          fen: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3',
          san: 'Bb5',
          moveNumber: 3,
          color: 'w' as const,
          from: 'f1' as const,
          to: 'b5' as const,
          comment: 'Exploring what could happen',
        },
      ],
    },
  ];

  const emptyComments = new Map<number, string>();
  const annotated = buildAnnotatedPgn(basePgn, emptyComments, finalMoveVars);

  assert.ok(annotated.includes('Nc6 ( 2... Nc6 3. Bb5 { Exploring what could happen } )'));
  assert.ok(annotated.endsWith('0-1'));

  const extracted = extractVariationsFromPgn(annotated);
  assert.strictEqual(extracted.length, 1);
  assert.strictEqual(extracted[0].branchPly, 3);
  assert.strictEqual(extracted[0].moves.length, 2);
  assert.strictEqual(extracted[0].moves[0].san, 'Nc6');
  assert.strictEqual(extracted[0].moves[0].moveNumber, 2);
  assert.strictEqual(extracted[0].moves[0].color, 'b');
  assert.strictEqual(extracted[0].moves[1].san, 'Bb5');
  assert.strictEqual(extracted[0].moves[1].moveNumber, 3);
  assert.strictEqual(extracted[0].moves[1].color, 'w');
});
