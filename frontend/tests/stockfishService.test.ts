import assert from 'node:assert/strict';
import test from 'node:test';
import { getStockfishWorkerUrl } from '../src/lib/stockfishService.ts';

test('getStockfishWorkerUrl on localhost should always return absolute root-based path', () => {
  // Test from root
  const urlRoot = getStockfishWorkerUrl({ hostname: 'localhost', pathname: '/' });
  assert.equal(urlRoot, '/stockfish/stockfish-19-lite-single.js');

  // Test from nested route /analysis/1 (must NOT be relative ./stockfish/... to avoid SPA 404 fallback)
  const urlAnalysis = getStockfishWorkerUrl({
    hostname: 'localhost',
    pathname: '/analysis/1',
  });
  assert.equal(urlAnalysis, '/stockfish/stockfish-19-lite-single.js');

  // Test from nested route /settings
  const urlSettings = getStockfishWorkerUrl({
    hostname: '127.0.0.1',
    pathname: '/settings',
  });
  assert.equal(urlSettings, '/stockfish/stockfish-19-lite-single.js');
});

test('getStockfishWorkerUrl on github.io should resolve repository subpath', () => {
  // Test github pages repo path https://user.github.io/my-chess-repo/analysis/1
  const url = getStockfishWorkerUrl({
    hostname: 'user.github.io',
    pathname: '/my-chess-repo/analysis/42',
  });
  assert.equal(url, '/my-chess-repo/stockfish/stockfish-19-lite-single.js');

  // Test github pages root https://user.github.io/
  const urlRoot = getStockfishWorkerUrl({
    hostname: 'user.github.io',
    pathname: '/',
  });
  assert.equal(urlRoot, '/stockfish/stockfish-19-lite-single.js');
});
