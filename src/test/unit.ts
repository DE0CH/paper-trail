// Fast, dependency-free unit tests (node:test) for the pure core modules:
// the navigation history (NavStacks) and the session-file format.
// Run with `npm run test:unit`; CI runs them before the e2e suite.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NavStacks } from '../core/history';
import { parseProgress, serializeProgress, PROGRESS_HEADER } from '../core/progressFormat';
import type { ProgressFile, SerializedState } from '../core/types';

const pos = (page: number, yRatio = 0) => ({ page, yRatio });

// ---------- NavStacks ----------

test('a fresh NavStacks has one stack with a Start entry and no undo', () => {
  const h = new NavStacks();
  assert.equal(h.stacks.length, 1);
  assert.equal(h.active.entries.length, 1);
  assert.equal(h.active.entries[0].label, 'Start');
  assert.equal(h.canUndo(), false);
});

test('visit truncates the forward tail like browser history', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.visit({ label: 'b', pos: pos(3) });
  h.back();
  h.visit({ label: 'c', pos: pos(4) });
  assert.deepEqual(h.active.entries.map((e) => e.label), ['Start', 'a', 'c']);
  assert.equal(h.active.index, 2);
});

test('fork copies the history up to the cursor into a new active stack', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.visit({ label: 'b', pos: pos(3) });
  h.back();
  h.fork({ label: 'branch', pos: pos(9) });
  assert.equal(h.stacks.length, 2);
  assert.deepEqual(h.active.entries.map((e) => e.label), ['Start', 'a', 'branch']);
  // the original keeps its full tail
  assert.deepEqual(h.stacks[0].entries.map((e) => e.label), ['Start', 'a', 'b']);
});

test('back and forward stop at the ends', () => {
  const h = new NavStacks();
  assert.equal(h.back(), null);
  h.visit({ label: 'a', pos: pos(2) });
  assert.equal(h.back()?.label, 'Start');
  assert.equal(h.back(), null);
  assert.equal(h.forward()?.label, 'a');
  assert.equal(h.forward(), null);
});

test('renaming an entry marks it edited; saving the same text does not', () => {
  const h = new NavStacks();
  h.visit({ label: 'auto', pos: pos(2) });
  h.renameEntry(1, 'auto'); // unchanged: not an edit
  assert.equal(h.active.entries[1].edited, undefined);
  h.renameEntry(1, 'mine');
  assert.equal(h.active.entries[1].edited, true);
});

test('setEntryPos refreshes automatic labels but keeps hand-written ones', () => {
  const h = new NavStacks();
  h.visit({ label: 'auto', pos: pos(2) });
  h.setEntryPos(1, pos(7, 0.5));
  assert.equal(h.active.entries[1].label, 'p. 7');
  h.renameEntry(1, 'mine');
  h.setEntryPos(1, pos(9));
  assert.equal(h.active.entries[1].label, 'mine');
  assert.deepEqual(h.active.entries[1].pos, pos(9));
});

test('newStack starts a fresh active trail at the given position', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.newStack(pos(5, 0.25));
  assert.equal(h.stacks.length, 2);
  assert.deepEqual(h.active.entries.map((e) => e.label), ['Start']);
  assert.deepEqual(h.active.entries[0].pos, pos(5, 0.25));
});

test('duplicateStack copies entries, cursor, and edited flags', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2) });
  h.visit({ label: 'b', pos: pos(3) });
  h.renameEntry(2, 'mine');
  h.back();
  const srcId = h.activeId;
  h.duplicateStack(srcId);
  assert.equal(h.stacks.length, 2);
  assert.notEqual(h.activeId, srcId);
  assert.equal(h.active.name, `${h.stacks[0].name} copy`);
  assert.equal(h.active.index, h.stacks[0].index);
  assert.deepEqual(h.active.entries.map((e) => e.label), ['Start', 'a', 'mine']);
  assert.equal(h.active.entries[2].edited, true);
});

test('undo history is capped at 50 snapshots, dropping the oldest', () => {
  const h = new NavStacks();
  for (let i = 0; i < 60; i++) h.visit({ label: `e${i}`, pos: pos(1) });
  let undos = 0;
  while (h.undo()) undos++;
  assert.equal(undos, 50);
  // 60 visits minus 50 undos leaves the first 10 in place
  assert.equal(h.active.entries.length, 11);
});

test('the last stack cannot be closed; closing is undoable', () => {
  const h = new NavStacks();
  assert.equal(h.closeStack(h.activeId), false);
  h.fork({ label: 'b', pos: pos(2) });
  const forkedId = h.activeId;
  assert.equal(h.closeStack(forkedId), true);
  assert.equal(h.stacks.length, 1);
  h.undo();
  assert.equal(h.stacks.length, 2);
});

test('serialize/load round-trips stacks, cursor, and edited flags', () => {
  const h = new NavStacks();
  h.visit({ label: 'a', pos: pos(2, 0.5) });
  h.renameEntry(1, 'mine');
  h.fork({ label: 'b', pos: pos(3) });
  const data = h.serialize();
  const h2 = new NavStacks();
  assert.equal(h2.load(data), true);
  assert.deepEqual(h2.serialize(), data);
  assert.equal(h2.load({ v: 99 }), false);
});

// ---------- session-file format ----------

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

test('a session file round-trips through serialize and parse', () => {
  const h = new NavStacks();
  h.visit({ label: 'Lemma 3.16', pos: pos(8, 0.2998) });
  h.renameEntry(1, 'my special place');
  h.fork({ label: 'Definition 2.4', pos: pos(12, 0.1) });
  const text = serializeProgress(fileFor(h));
  const parsed = parseProgress(text);
  assert.ok(parsed);
  assert.equal(parsed.pdf.name, 'WStarCats.pdf');
  assert.equal(parsed.state.scale, 1.25);
  assert.deepEqual(parsed.state.pos, pos(17, 0.42));
  const stacks = parsed.state.hist.stacks;
  assert.equal(stacks.length, 2);
  assert.deepEqual(stacks[1].entries.map((e) => e.label),
    ['Start', 'my special place', 'Definition 2.4']);
  assert.equal(stacks[1].entries[1].edited, true);
  assert.equal(stacks[1].entries[2].edited, undefined);
});

test('the file contains no hidden identifiers, only the PDF name', () => {
  const text = serializeProgress(fileFor(new NavStacks()));
  assert.match(text, /^pdf\.name WStarCats\.pdf$/m);
  assert.doesNotMatch(text, /fingerprint|relPath|pdf\.size/);
});

test('hand-named entries use named lines; automatic ones use entry lines', () => {
  const h = new NavStacks();
  h.visit({ label: 'auto', pos: pos(9, 0.1) });
  h.renameEntry(1, 'my own label');
  const text = serializeProgress(fileFor(h));
  assert.match(text, /^named 9 0\.1 my own label$/m);
  assert.match(text, /^entry 1 0 Start$/m);
});

test('newlines in free text are flattened on save', () => {
  const h = new NavStacks();
  h.visit({ label: 'line one\nline two', pos: pos(2) });
  const text = serializeProgress(fileFor(h));
  assert.match(text, /^entry 2 0 line one line two$/m);
  assert.ok(parseProgress(text));
});

test('legacy files with fingerprint/relPath/size lines still parse', () => {
  const legacy = [
    PROGRESS_HEADER,
    'saved 2026-07-10T12:34:56.000Z',
    'pdf.name Old.pdf',
    'pdf.relPath ../Old.pdf',
    'pdf.fingerprint deadbeef',
    'pdf.size 12345',
    'view.scale 1',
    'active 0',
    '',
    'stack Main',
    'cursor 0',
    'entry 1 0 Start',
    '',
  ].join('\n');
  const parsed = parseProgress(legacy);
  assert.ok(parsed);
  assert.equal(parsed.pdf.name, 'Old.pdf');
  assert.equal(parsed.state.hist.stacks[0].name, 'Main');
});

test('parse rejects garbage, wrong headers, and structureless files', () => {
  assert.equal(parseProgress('not a session file'), null);
  assert.equal(parseProgress(`${PROGRESS_HEADER}\nentry 1 0 orphan\n`), null);
  assert.equal(parseProgress(`${PROGRESS_HEADER}\nstack empty\n`), null);
});
