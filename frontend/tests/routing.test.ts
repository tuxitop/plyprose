import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBasePath,
  getAnalysisUrl,
  getSettingsUrl,
  getGamesUrl,
} from '../src/lib/routing.ts';

test('getBasePath on GitHub Pages project site resolves repository name', () => {
  // Main app root on GitHub Pages
  assert.equal(
    getBasePath({ hostname: 'tuxitop.github.io', pathname: '/plyprose/' }),
    '/plyprose',
  );

  // Deep analysis route on GitHub Pages
  assert.equal(
    getBasePath({
      hostname: 'tuxitop.github.io',
      pathname: '/plyprose/analysis/chess.com%2Fblitz%2F2026-11%2F04-1758-lisa_offjcjal-tuxitop-black',
    }),
    '/plyprose',
  );

  // Settings route on GitHub Pages
  assert.equal(
    getBasePath({ hostname: 'tuxitop.github.io', pathname: '/plyprose/settings' }),
    '/plyprose',
  );
});

test('getBasePath on GitHub Pages user site (no repository subpath) returns empty', () => {
  // If user site has route at root /analysis/1 (should not mistake 'analysis' for repo name)
  assert.equal(
    getBasePath({ hostname: 'tuxitop.github.io', pathname: '/analysis/1' }),
    '',
  );
  assert.equal(
    getBasePath({ hostname: 'tuxitop.github.io', pathname: '/settings' }),
    '',
  );
  assert.equal(
    getBasePath({ hostname: 'tuxitop.github.io', pathname: '/' }),
    '',
  );
});

test('getBasePath on localhost or custom domain without base returns empty', () => {
  assert.equal(
    getBasePath({ hostname: 'localhost', pathname: '/analysis/1' }),
    '',
  );
  assert.equal(
    getBasePath({ hostname: '127.0.0.1', pathname: '/' }),
    '',
  );
});

test('getAnalysisUrl builds base-aware URLs with properly encoded game identifiers', () => {
  const loc = { hostname: 'tuxitop.github.io', pathname: '/plyprose/' };
  const rawId = 'chess.com/blitz/2026-11/04-1758-lisa_offjcjal-tuxitop-black';
  const url = getAnalysisUrl(rawId, loc);

  assert.equal(
    url,
    '/plyprose/analysis/chess.com%2Fblitz%2F2026-11%2F04-1758-lisa_offjcjal-tuxitop-black',
  );

  // On localhost
  const localUrl = getAnalysisUrl(42, { hostname: 'localhost', pathname: '/' });
  assert.equal(localUrl, '/analysis/42');
});

test('getSettingsUrl and getGamesUrl preserve base path on GitHub Pages', () => {
  const loc = { hostname: 'tuxitop.github.io', pathname: '/plyprose/' };
  assert.equal(getSettingsUrl(loc), '/plyprose/settings');
  assert.equal(getGamesUrl(loc), '/plyprose/');

  const localLoc = { hostname: 'localhost', pathname: '/' };
  assert.equal(getSettingsUrl(localLoc), '/settings');
  assert.equal(getGamesUrl(localLoc), '/');
});
