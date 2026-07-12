// Edge cases of the core model beyond unit.ts: hostile or unusual
// session files (CRLF, junk lines, newer versions, orphaned entries,
// boundary numbers, non-ASCII text) and NavStacks invariants under
// awkward sequences (multi-step undo/redo, out-of-bounds loads,
// operations on non-active stacks).
// Run: node --test build-node/test/unitEdges.js

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NavStacks } from '../core/history';
import {
  parseProgress, serializeProgress, progressVersion, PROGRESS_HEADER,
} from '../core/progressFormat';
import type { ProgressFile, SerializedState } from '../core/types';

const pos = (page: number, yRatio = 0) => ({ page, yRatio });

function fileFor(h: NavStacks, name = 'WStarCats.pdf'): ProgressFile {
  const state: SerializedState = {
    v: 1,
    name,
    scale: 1.25,
    fitWidth: false,
    hist: h.serialize(),
    pos: pos(17, 0.42),
    ts: Date.now(),
  };
  return {
    type: 'pdf-stack-reader-progress',
    v: 1,
    savedAt: Date.now(),
    pdf: { name },
    state,
  };
}

// ---------- NavStacks under awkward sequences ----------

test('a new mutation after undo clears redo for good', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.visit({ label: 'b', pos: pos(3) });
  h.undo();
  assert.equal(h.canRedo(), true);
  h.visit({ label: 'c', pos: pos(4) });
  assert.equal(h.canRedo(), false);
  assert.deepEqual(h.active.entries.map((e) => e.label), ['Start', 'a', 'c']);
});

test('multi-step undo and redo walk the exact same states back and forth', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.visit({ label: 'b', pos: pos(3) });
  h.visit({ label: 'c', pos: pos(4) });
  const labels = () => h.active.entries.map((e) => e.label).join(',');
  const states = [labels()];
  h.undo(); states.unshift(labels());
  h.undo(); states.unshift(labels());
  assert.equal(states[0], 'Start,a');
  h.redo();
  assert.equal(labels(), states[1]);
  h.redo();
  assert.equal(labels(), states[2]);
  assert.equal(h.canRedo(), false);
});

test('undo at the bottom and redo at the top are refusals, not crashes', () => {
  const h = new NavStacks();
  assert.equal(h.undo(), false);
  assert.equal(h.redo(), false);
  h.visit({ label: 'a', pos: pos(2) });
  h.undo();
  assert.equal(h.undo(), false);
  assert.equal(h.active.entries.length, 1);
});

test('loading a file with an out-of-bounds cursor clamps it', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  const data = JSON.parse(JSON.stringify(h.serialize())) as {
    stacks: Array<{ index: number }>;
  };
  data.stacks[0].index = 99;
  const g = new NavStacks();
  assert.equal(g.load(data), true);
  assert.ok(g.active.index >= 0 && g.active.index < g.active.entries.length,
    `cursor ${g.active.index} of ${g.active.entries.length}`);
});

test('loading a file whose active id points nowhere falls back to a real stack', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  const data = JSON.parse(JSON.stringify(h.serialize())) as { active: number };
  data.active = 424242;
  const g = new NavStacks();
  assert.equal(g.load(data), true);
  assert.ok(g.stacks.some((s) => s.id === g.activeId));
  assert.ok(g.active.entries.length >= 1);
});

test('loading garbage fails cleanly and leaves the instance usable', () => {
  const h = new NavStacks();
  h.visit({ label: 'keep', pos: pos(2) });
  assert.equal(h.load('not stacks at all'), false);
  assert.equal(h.load({ stacks: 'nope' }), false);
  assert.deepEqual(h.active.entries.map((e) => e.label), ['Start', 'keep']);
  h.visit({ label: 'still works', pos: pos(3) });
  assert.equal(h.active.entries.length, 3);
});

test('duplicating a non-active stack copies it and makes the copy active', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  const firstId = h.activeId;
  h.newStack(pos(5));
  assert.notEqual(h.activeId, firstId);
  h.duplicateStack(firstId);
  assert.deepEqual(h.active.entries.map((e) => e.label),
    h.stacks.find((s) => s.id === firstId)!.entries.map((e) => e.label));
  assert.notEqual(h.activeId, firstId);
});

test('closing a non-active stack leaves the active one alone', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  const firstId = h.activeId;
  h.newStack(pos(5));
  const activeBefore = h.activeId;
  assert.equal(h.closeStack(firstId), false); // false: closed one was not active
  assert.equal(h.activeId, activeBefore);
  assert.equal(h.stacks.length, 1);
});

// ---------- hostile and unusual session files ----------

test('a Windows-edited (CRLF) session file still parses, labels unharmed', () => {
  const h = new NavStacks();
  h.visit({ label: 'Lemma 3.16', pos: pos(8, 0.3) });
  const crlf = serializeProgress(fileFor(h)).replace(/\n/g, '\r\n');
  const parsed = parseProgress(crlf);
  assert.ok(parsed, 'CRLF file must parse');
  const labels = parsed!.state.hist.stacks.flatMap((s) =>
    s.entries.map((e) => e.label));
  assert.ok(labels.includes('Lemma 3.16'), JSON.stringify(labels));
  assert.ok(labels.every((l) => !l.includes('\r')), 'no stray carriage returns');
});

test('unknown extra lines are ignored, the file still loads', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  const text = serializeProgress(fileFor(h))
    .replace('\n\n', '\nfuture.knob true\nx-comment written by hand\n\n');
  assert.ok(parseProgress(text));
});

test('a header-only file is rejected, not half-loaded', () => {
  assert.equal(parseProgress(`${PROGRESS_HEADER}\n`), null);
  assert.equal(parseProgress(`${PROGRESS_HEADER}\nsaved 2026-01-01\n\n`), null);
});

test('an entry before any stack line is rejected', () => {
  const h = new NavStacks();
  const good = serializeProgress(fileFor(h));
  const orphan = good.replace(/\nstack /, '\nentry 3 0.5 orphan\nstack ');
  assert.equal(parseProgress(orphan), null);
});

test('non-numeric entry fields are rejected', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  const good = serializeProgress(fileFor(h));
  const bad = good.replace(/entry (\d+) /, 'entry NaNny ');
  assert.equal(parseProgress(bad), null);
});

test('a newer format version is refused but still identifies itself', () => {
  const h = new NavStacks();
  const v2 = serializeProgress(fileFor(h))
    .replace(`${PROGRESS_HEADER}`, 'paper-trail-session v2');
  assert.equal(parseProgress(v2), null);
  assert.equal(progressVersion(v2), 2);
});

test('progressVersion on non-session text says "not a session file"', () => {
  assert.equal(progressVersion('%PDF-1.7 garbage'), null);
  assert.equal(progressVersion(''), null);
  assert.equal(progressVersion('paper-trail-session vNaN'), null);
});

test('CJK, emoji and RTL text round-trip in names and labels', () => {
  const h = new NavStacks();
  h.visit({ label: '定理 3.16 🎯 مثال', pos: pos(8, 0.25) });
  h.renameStack(h.activeId, '读书笔记 ✓');
  h.renameEntry(1, 'Théorème « quoté »');
  const parsed = parseProgress(serializeProgress(fileFor(h, '论文.pdf')));
  assert.ok(parsed);
  assert.equal(parsed!.pdf.name, '论文.pdf');
  const stack = parsed!.state.hist.stacks[0];
  assert.equal(stack.name, '读书笔记 ✓');
  assert.equal(stack.entries[1].label, 'Théorème « quoté »');
});

test('labels that look like numbers or contain many spaces survive', () => {
  const h = new NavStacks();
  h.visit({ label: '42 0.5 17', pos: pos(3, 0.5) });
  h.visit({ label: 'spaced   out   label', pos: pos(4) });
  const parsed = parseProgress(serializeProgress(fileFor(h)));
  assert.ok(parsed);
  const labels = parsed!.state.hist.stacks[0].entries.map((e) => e.label);
  assert.ok(labels.includes('42 0.5 17'), JSON.stringify(labels));
  assert.ok(labels.includes('spaced   out   label'), JSON.stringify(labels));
});

test('boundary positions (yRatio 0 and 1) round-trip exactly', () => {
  const h = new NavStacks();
  h.visit({ label: 'top', pos: pos(1, 0) });
  h.visit({ label: 'bottom', pos: pos(41, 1) });
  const parsed = parseProgress(serializeProgress(fileFor(h)));
  assert.ok(parsed);
  const entries = parsed!.state.hist.stacks[0].entries;
  assert.equal(entries[1].pos.yRatio, 0);
  assert.equal(entries[2].pos.yRatio, 1);
});

test('the active stack index survives a round-trip with several stacks', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.newStack(pos(5));
  h.newStack(pos(9));
  h.switchStack(h.stacks[1].id);
  const parsed = parseProgress(serializeProgress(fileFor(h)));
  assert.ok(parsed);
  const g = new NavStacks();
  assert.equal(g.load(parsed!.state.hist), true);
  assert.equal(g.stacks.findIndex((s) => s.id === g.activeId), 1);
});
