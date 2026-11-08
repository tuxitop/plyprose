import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getUserOutcome,
  resultBadgeVariant,
  resultLabel,
} from '../src/lib/badges.ts';

test('getUserOutcome correctly determines user win when playing Black with 0-1', () => {
  // Explicit side: black
  const outcome1 = getUserOutcome('0-1', 'black', 'BriBri333', 'tuxitop');
  assert.equal(outcome1, 'win');

  // Resolved side from player name candidates (tuxitop as Black)
  const outcome2 = getUserOutcome('0-1', undefined, 'BriBri333', 'tuxitop');
  assert.equal(outcome2, 'win');

  assert.equal(resultLabel('0-1', 'black', 'BriBri333', 'tuxitop'), 'Win');
  assert.equal(resultBadgeVariant('0-1', 'black', 'BriBri333', 'tuxitop'), 'emerald');

  assert.equal(resultLabel('0-1', undefined, 'BriBri333', 'tuxitop'), 'Win');
  assert.equal(resultBadgeVariant('0-1', undefined, 'BriBri333', 'tuxitop'), 'emerald');
});

test('getUserOutcome correctly determines user loss when playing Black with 1-0', () => {
  const outcome = getUserOutcome('1-0', 'black', 'Opponent', 'tuxitop');
  assert.equal(outcome, 'loss');
  assert.equal(resultLabel('1-0', 'black', 'Opponent', 'tuxitop'), 'Loss');
  assert.equal(resultBadgeVariant('1-0', 'black', 'Opponent', 'tuxitop'), 'rose');
});

test('getUserOutcome correctly determines user win when playing White with 1-0', () => {
  const outcome = getUserOutcome('1-0', 'white', 'tuxitop', 'Opponent');
  assert.equal(outcome, 'win');
  assert.equal(resultLabel('1-0', 'white', 'tuxitop', 'Opponent'), 'Win');
  assert.equal(resultBadgeVariant('1-0', 'white', 'tuxitop', 'Opponent'), 'emerald');
});

test('getUserOutcome correctly determines user loss when playing White with 0-1', () => {
  const outcome = getUserOutcome('0-1', 'white', 'tuxitop', 'Opponent');
  assert.equal(outcome, 'loss');
  assert.equal(resultLabel('0-1', 'white', 'tuxitop', 'Opponent'), 'Loss');
  assert.equal(resultBadgeVariant('0-1', 'white', 'tuxitop', 'Opponent'), 'rose');
});

test('getUserOutcome handles draws and unknown results', () => {
  assert.equal(getUserOutcome('1/2-1/2', 'white', 'tuxitop', 'Opponent'), 'draw');
  assert.equal(resultLabel('1/2-1/2', 'white', 'tuxitop', 'Opponent'), 'Draw');
  assert.equal(resultBadgeVariant('1/2-1/2', 'white', 'tuxitop', 'Opponent'), 'slate');

  assert.equal(getUserOutcome('*', 'white', 'tuxitop', 'Opponent'), 'unknown');
  assert.equal(resultLabel('*', 'white', 'tuxitop', 'Opponent'), '*');
});
