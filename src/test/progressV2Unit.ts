// Format v2 drops the `saved` timestamp (it churned every git diff), and
// v1 files keep their version AND their recorded time untouched when
// saved back. These tests pin both promises plus the compatibility
// boundary (v0/v3 refused, v1/v2 accepted).
// Run: node --test build-node/test/progressV2Unit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProgress, serializeProgress, PROGRESS_HEADER, PROGRESS_VERSION,
} from '../core/progressFormat';
import type { ProgressFile } from '../core/types';

const body = [
  'pdf.name paper.pdf',
  'view.scale 1.25',
  'view.fitWidth false',
  'view.page 3',
  'view.yRatio 0.5',
  'active 0',
  '',
  'stack Main',
  'cursor 0',
  'entry 1 0 Start',
  '',
];

const v1File = (saved: string | null) => [
  'paper-trail-session v1',
  ...(saved === null ? [] : [`saved ${saved}`]),
  ...body,
].join('\n');

function freshFile(): ProgressFile {
  const parsed = parseProgress([PROGRESS_HEADER, ...body].join('\n'));
  assert.ok(parsed);
  return parsed;
}

test('the current version is 2 and new files carry no time at all', () => {
  assert.equal(PROGRESS_VERSION, 2);
  const text = serializeProgress(freshFile());
  assert.match(text, /^paper-trail-session v2\n/);
  assert.doesNotMatch(text, /^saved /m);
});

test('a v2 file round-trips: parses as v2 and serializes without a saved line', () => {
  const parsed = freshFile();
  assert.equal(parsed.v, 2);
  const again = serializeProgress(parsed);
  assert.doesNotMatch(again, /^saved /m);
  assert.ok(parseProgress(again));
});

test('a v1 file stays v1 and its recorded time round-trips verbatim', () => {
  const parsed = parseProgress(v1File('2026-07-10T12:34:56.000Z'));
  assert.ok(parsed);
  assert.equal(parsed.v, 1);
  const text = serializeProgress(parsed);
  assert.match(text, /^paper-trail-session v1\n/);
  assert.match(text, /^saved 2026-07-10T12:34:56\.000Z$/m);
});

test('an oddly formatted v1 time is preserved byte-for-byte, never rewritten', () => {
  const parsed = parseProgress(v1File('2026-01-01'));
  assert.ok(parsed);
  const text = serializeProgress(parsed);
  assert.match(text, /^saved 2026-01-01$/m);
});

test('a v1 file that never had a saved line does not gain one', () => {
  const parsed = parseProgress(v1File(null));
  assert.ok(parsed);
  assert.equal(parsed.v, 1);
  assert.doesNotMatch(serializeProgress(parsed), /^saved /m);
});

test('a stray saved line in a v2 file is ignored and dropped on save', () => {
  const parsed = parseProgress(
    [PROGRESS_HEADER, 'saved 2026-07-10T12:34:56.000Z', ...body].join('\n'));
  assert.ok(parsed);
  assert.equal(parsed.savedRaw, undefined);
  assert.doesNotMatch(serializeProgress(parsed), /^saved /m);
});

test('newer and ancient majors are refused; v1 and v2 are accepted', () => {
  const v = (n: number) => [`paper-trail-session v${n}`, ...body].join('\n');
  assert.equal(parseProgress(v(3)), null);
  assert.equal(parseProgress(v(0)), null);
  assert.ok(parseProgress(v(1)));
  assert.ok(parseProgress(v(2)));
});
