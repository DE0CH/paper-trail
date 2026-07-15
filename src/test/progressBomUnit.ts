// A UTF-8 BOM (U+FEFF) prefixing a .ptl must not reject the file — Windows
// Notepad, for one, saves UTF-8 with a BOM, and users edit session files by
// hand. Today this works because progressVersion() trims the header line and
// U+FEFF is ECMAScript WhiteSpace; these tests PIN that behavior so a future
// stricter header match can't quietly break BOM'd files.
// Run: node --test build-node/test/progressBomUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgress, progressVersion } from '../core/progressFormat';

const SESSION = [
  'paper-trail-session v1',
  'saved 2026-07-15T00:00:00.000Z',
  'pdf.name paper.pdf',
  'view.scale 1.25',
  'view.fitWidth false',
  'view.page 3',
  'view.yRatio 0.5',
  'active 0',
  '',
  'stack Main',
  'cursor 1',
  'entry 1 0 Start',
  'named 3 0.5 my spot',
  '',
];

test('a BOM-prefixed session file parses', () => {
  const p = parseProgress('﻿' + SESSION.join('\n'));
  assert.ok(p, 'parseProgress returned null for a BOM-prefixed valid file');
  assert.equal(p.pdf.name, 'paper.pdf');
  assert.equal(p.state.pos.page, 3);
  assert.equal(p.state.hist.stacks[0].entries.length, 2);
});

test('a BOM-prefixed CRLF session file parses', () => {
  const p = parseProgress('﻿' + SESSION.join('\r\n'));
  assert.ok(p);
  assert.equal(p.pdf.name, 'paper.pdf');
});

test('progressVersion reads through a BOM', () => {
  assert.equal(progressVersion('﻿paper-trail-session v1\n'), 1);
  assert.equal(progressVersion('﻿paper-trail-session v7\n'), 7);
});

test('a BOM alone is still not a session file', () => {
  assert.equal(parseProgress('﻿'), null);
  assert.equal(progressVersion('﻿'), null);
});
