import assert from 'node:assert/strict';
import test from 'node:test';
import { svgToBase64DataUri } from '../src/lib/githubDirect.ts';

test('svgToBase64DataUri generates valid base64 data URI without utf8 mime parameters', () => {
  const sampleSvg = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>';
  const uri = svgToBase64DataUri(sampleSvg);

  assert.ok(uri.startsWith('data:image/svg+xml;base64,'), 'Must start with data:image/svg+xml;base64,');
  assert.ok(!uri.includes('utf8'), 'Must NOT contain invalid utf8 mime parameter');

  // Verify decoded content equals original SVG
  const base64Part = uri.replace('data:image/svg+xml;base64,', '');
  const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
  assert.equal(decoded, sampleSvg);
});

test('svgToBase64DataUri properly encodes complex SVG with url references and markers', () => {
  const complexSvg =
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><marker id="arrow"></marker></defs><path fill="url(#arrow)" d="M 0 0"/></svg>';
  const uri = svgToBase64DataUri(complexSvg);

  assert.ok(uri.startsWith('data:image/svg+xml;base64,'));
  // Ensure no unencoded parentheses or hash signs in data URI
  const base64Part = uri.replace('data:image/svg+xml;base64,', '');
  assert.ok(!base64Part.includes('('));
  assert.ok(!base64Part.includes(')'));
  assert.ok(!base64Part.includes('#'));

  const decoded = Buffer.from(base64Part, 'base64').toString('utf-8');
  assert.equal(decoded, complexSvg);
});
