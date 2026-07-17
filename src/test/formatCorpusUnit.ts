// Back-compat regression corpus for the .ptl session format: one committed
// fixture per historical variant (src/test/fixtures/ptl/), each proven to
// still parse with the right content and to round-trip under the version
// preservation rules (a file keeps the version — and the recorded time —
// it was loaded with).
//
// The corpus, with the release era each fixture represents:
//   v1-earliest-legacy.ptl  v0.2.0–v0.4.0 writer output: `saved <ISO>` plus
//                           the legacy pdf.relPath / pdf.fingerprint /
//                           pdf.size identity lines (dropped from the writer
//                           in v0.4.1, commit 9fb0515) and automatic-label
//                           `entry` lines only (`named` arrived in v0.4.1,
//                           commit 19f1c4b). v0.2.0 shipped it as `.trail`;
//                           v0.3.1 renamed the extension to `.ptl` with the
//                           file contents unchanged.
//   v1-standard.ptl         v0.4.1–v1.0.0 writer output: `saved <ISO>`,
//                           pdf.name only, `entry` + `named` lines.
//   v1-no-saved.ptl         hand-trimmed v1 (no writer ever omitted `saved`,
//                           but users edit .ptl by hand and the parser
//                           tolerates its absence; saving must not add one).
//   v1-bom.ptl              v1 re-saved by a Windows editor with a UTF-8 BOM.
//   v1-odd-saved.ptl        v1 with a hand-edited non-ISO `saved` value,
//                           which must round-trip byte-identically.
//   v1-crlf.ptl             v1 re-saved with CRLF line endings.
//   v2-current.ptl          v1.1.0+ writer output (no `saved` line at all);
//                           byte-identical serialize(parse(text)) === text.
//   v2-stray-saved.ptl      v2 with a hand-added `saved` line, which is
//                           ignored and dropped on save.
//
// Excluded pre-release formats, kept only as refused-input fixtures:
//   unreleased-json-era.psr.json  The original JSON incarnation (type
//       "pdf-stack-reader-progress", commit 7672f00, written as
//       <pdf>.psr.json). It existed only in the pre-release tree for a few
//       hours: the rewrite (af12fc2, the same day) replaced it with the
//       line-oriented text format, and the first release ever cut (v0.2.0)
//       already wrote `paper-trail-session v1`. No released build ever
//       wrote JSON, so there is nothing to migrate — the parser just
//       refuses it like any non-session text.
//   unreleased-psr-progress-v2.psr  The `psr-progress v1`/`v2` text headers
//       (commits af12fc2 and d61d75f) also predate the first release:
//       commit 0427af3 renamed the header to `paper-trail-session v1`
//       noting "no released users; no legacy support". Refused by version
//       detection, never misread.
//
// Byte-guard tests pin the fixture bytes themselves (BOM present, CRLF
// present) so git normalization or an editor could never quietly turn the
// corpus into a vacuous LF-only copy (.gitattributes `* -text` protects
// them at the git layer).
//
// Run: node --test build-node/test/formatCorpusUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseProgress, serializeProgress, progressVersion } from '../core/progressFormat';
import type { ProgressFile } from '../core/types';

// build-node/test -> the committed fixtures under src/test/fixtures/ptl.
const FIXTURES = path.resolve(__dirname, '..', '..', 'src', 'test', 'fixtures', 'ptl');

const read = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const readBytes = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

function parsed(name: string): ProgressFile {
  const p = parseProgress(read(name));
  assert.ok(p, `${name} must parse`);
  return p;
}

const savedLine = (text: string) =>
  text.split(/\r?\n/).find((l) => l.startsWith('saved ')) ?? null;

test('every positive fixture in the corpus parses', () => {
  for (const name of fs.readdirSync(FIXTURES)) {
    if (!name.endsWith('.ptl')) continue;
    assert.ok(parseProgress(read(name)), `${name} must parse`);
  }
});

test('earliest shipped v1 (v0.2.0-era, legacy pdf identity lines) restores fully', () => {
  const p = parsed('v1-earliest-legacy.ptl');
  assert.equal(p.v, 1);
  // The legacy relPath/fingerprint/size lines identify a DIFFERENT file on
  // purpose: only the visible name may matter, the rest is ignored.
  assert.equal(p.pdf.name, 'WStarCats.pdf');
  assert.equal(p.state.scale, 1.2745098039215685);
  assert.equal(p.state.fitWidth, true);
  assert.deepEqual(p.state.pos, { page: 17, yRatio: 0.42021803766105054 });
  const stacks = p.state.hist.stacks;
  assert.deepEqual(stacks.map((s) => s.name), ['RoundTrip', 'Détour — §3 examples']);
  assert.deepEqual(stacks.map((s) => s.index), [1, 2]);
  assert.deepEqual(stacks[0].entries.map((e) => e.label), ['Start', 'Lemma test-marker']);
  assert.deepEqual(
    stacks[1].entries.map((e) => e.label),
    ['Start', 'Example 3.7', 'Corollary 3.12'],
  );
  assert.deepEqual(stacks[1].entries[2].pos, { page: 9, yRatio: 0.6180339887498949 });
  // `active 1` selects the second stack; no entry carries an edited flag
  // (the era predates `named`).
  assert.equal(p.state.hist.activeId, stacks[1].id);
  assert.ok(stacks.every((s) => s.entries.every((e) => !e.edited)));
});

test('earliest v1 saves back as v1: saved line byte-identical, legacy lines dropped', () => {
  const text = read('v1-earliest-legacy.ptl');
  const out = serializeProgress(parsed('v1-earliest-legacy.ptl'));
  assert.match(out, /^paper-trail-session v1\n/);
  assert.equal(savedLine(out), savedLine(text));
  assert.equal(savedLine(out), 'saved 2026-07-10T18:00:00.000Z');
  // Pinned on purpose: the hidden identity lines never come back — since
  // 9fb0515 the file holds nothing the user can't see.
  assert.doesNotMatch(out, /pdf\.(relPath|fingerprint|size)/);
});

test('standard v1 (v0.4.1–v1.0.0 era) restores names, labels, edited flags', () => {
  const p = parsed('v1-standard.ptl');
  assert.equal(p.v, 1);
  assert.equal(p.pdf.name, 'WStarCats.pdf');
  const stacks = p.state.hist.stacks;
  assert.deepEqual(stacks.map((s) => s.name), ['Haupttrail — Äquivarianz', 'Untitled 2']);
  assert.equal(p.state.hist.activeId, stacks[0].id);
  assert.equal(stacks[0].index, 1);
  assert.deepEqual(
    stacks[0].entries.map((e) => e.label),
    ['Start', '定理 4.2 — my favourite spot', 'Definition 4.1'],
  );
  // `named` marks the hand-written label; `entry` stays automatic.
  assert.deepEqual(stacks[0].entries.map((e) => !!e.edited), [false, true, false]);
  // "Untitled 2" in the file pushes the fresh-name counter past it.
  assert.equal(p.state.hist.nameCounter, 3);
  const out = serializeProgress(p);
  assert.match(out, /^paper-trail-session v1\n/);
  assert.equal(savedLine(out), 'saved 2026-07-14T09:30:12.345Z');
});

test('a v1 file without a saved line parses and never gains one', () => {
  const p = parsed('v1-no-saved.ptl');
  assert.equal(p.v, 1);
  assert.equal(p.savedRaw, undefined);
  assert.deepEqual(p.state.hist.stacks[0].entries.map((e) => !!e.edited), [false, true]);
  const out = serializeProgress(p);
  assert.match(out, /^paper-trail-session v1\n/);
  assert.equal(savedLine(out), null);
});

test('the BOM fixture really starts with EF BB BF (byte guard)', () => {
  const bytes = readBytes('v1-bom.ptl');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('a BOM-prefixed v1 file parses and round-trips its saved line', () => {
  const raw = readBytes('v1-bom.ptl').toString('utf8'); // keeps U+FEFF
  assert.equal(raw.charCodeAt(0), 0xfeff);
  const p = parseProgress(raw);
  assert.ok(p);
  assert.equal(p.v, 1);
  assert.equal(p.pdf.name, 'WStarCats.pdf');
  assert.deepEqual(p.state.hist.stacks[0].entries.map((e) => e.label), ['Start', 'my spot']);
  assert.equal(savedLine(serializeProgress(p)), 'saved 2026-07-12T22:15:00.000Z');
});

test('an oddly formatted saved value survives byte-identically', () => {
  const p = parsed('v1-odd-saved.ptl');
  assert.equal(p.savedRaw, '2026-01-01');
  assert.equal(savedLine(serializeProgress(p)), 'saved 2026-01-01');
});

test('the CRLF fixture really contains CR LF line endings (byte guard)', () => {
  assert.ok(readBytes('v1-crlf.ptl').includes(Buffer.from('\r\n')),
    'v1-crlf.ptl lost its CRLF endings — check .gitattributes normalization');
});

test('a CRLF v1 file parses with full content and a verbatim saved line', () => {
  const p = parsed('v1-crlf.ptl');
  assert.equal(p.v, 1);
  assert.equal(p.state.hist.stacks[0].name, 'Windows notepad edit');
  assert.deepEqual(p.state.hist.stacks[0].entries.map((e) => e.label),
    ['Start', 'golden section']);
  assert.deepEqual(p.state.hist.stacks[0].entries.map((e) => !!e.edited), [false, true]);
  assert.equal(p.state.pos.yRatio, 0.6180339887498949);
  assert.equal(savedLine(serializeProgress(p)), 'saved 2026-07-13T08:00:00.000Z');
});

test('the current v2 fixture round-trips byte-identically with no saved line', () => {
  const text = read('v2-current.ptl');
  const p = parseProgress(text);
  assert.ok(p);
  assert.equal(p.v, 2);
  assert.equal(p.keepV1, undefined);
  assert.deepEqual(p.state.hist.stacks.map((s) => s.name), ['RoundTrip', 'Séance №2 — 圏論']);
  assert.equal(p.state.hist.activeId, p.state.hist.stacks[1].id);
  assert.deepEqual(p.state.hist.stacks[0].entries.map((e) => !!e.edited), [false, true]);
  const out = serializeProgress(p);
  assert.equal(savedLine(out), null);
  assert.equal(out, text, 'v2 writer output must round-trip byte-for-byte');
});

test('a stray saved line in a v2 file is ignored and dropped on save', () => {
  const p = parsed('v2-stray-saved.ptl');
  assert.equal(p.v, 2);
  assert.equal(p.savedRaw, undefined);
  assert.equal(p.state.hist.stacks[0].name, 'Stray timestamp');
  const out = serializeProgress(p);
  assert.match(out, /^paper-trail-session v2\n/);
  assert.equal(savedLine(out), null);
});

test('the pre-release psr-progress and JSON formats are refused, never misread', () => {
  const psr = read('unreleased-psr-progress-v2.psr');
  assert.equal(progressVersion(psr), null);
  assert.equal(parseProgress(psr), null);
  const json = read('unreleased-json-era.psr.json');
  assert.equal(progressVersion(json), null);
  assert.equal(parseProgress(json), null);
});
