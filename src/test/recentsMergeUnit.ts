// Unit tests for the recents read-merge-write logic (store.ts): several
// windows share ONE stored list, so every mutation must merge into a fresh
// read of the store, never write a stale snapshot back blind. Pure logic
// with injected store I/O — no IndexedDB, no browser.
// Run: node --test build-node/test/recentsMergeUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordRecentMerged, removeRecentMerged, type RecentsIO } from '../core/store';
import type { RecentEntry } from '../core/recents';

// Path-identity entries (desktop opens): matching is plain string equality,
// which keeps these tests about the MERGE logic, not handle comparison.
function pentry(pdfPath: string, sessionPath: string | null, ts: number): RecentEntry {
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  return {
    pdf: pdfPath,
    session: sessionPath,
    pdfName: base(pdfPath),
    sessionFileName: sessionPath ? base(sessionPath) : null,
    timestamp: ts,
  };
}

/** An in-memory store standing in for IndexedDB, shared between "windows". */
function memStore(initial: RecentEntry[] = []): { io: RecentsIO; list(): RecentEntry[] } {
  let stored = initial;
  return {
    io: {
      load: async () => [...stored],
      save: async (l: RecentEntry[]) => { stored = [...l]; },
    },
    list: () => stored,
  };
}

test('a record merges into the CURRENT store, not a stale snapshot', async () => {
  // Window 2 already saved b.pdf after window 1 attached; window 1's record
  // of a.pdf must keep it.
  const store = memStore([pentry('/d/b.pdf', null, 200)]);
  await recordRecentMerged(pentry('/d/a.pdf', null, 300), store.io);
  assert.deepEqual(store.list().map((e) => e.pdfName).sort(), ['a.pdf', 'b.pdf']);
});

test('a startup record never wipes an established store', async () => {
  const store = memStore([1, 2, 3, 4, 5].map((i) => pentry(`/d/p${i}.pdf`, null, i * 100)));
  await recordRecentMerged(pentry('/d/new.pdf', '/d/new.ptl', 900), store.io);
  assert.equal(store.list().length, 6);
  assert.equal(store.list()[0].pdfName, 'new.pdf'); // newest first
});

test('interleaved writers lose nothing', async () => {
  const store = memStore();
  await recordRecentMerged(pentry('/d/a.pdf', null, 100), store.io);
  await recordRecentMerged(pentry('/d/b.pdf', '/d/b.ptl', 200), store.io);
  await recordRecentMerged(pentry('/d/a.pdf', '/d/a.ptl', 300), store.io); // upgrades a
  assert.equal(store.list().length, 2, 'the a.pdf row upgraded in place');
  assert.deepEqual(store.list().map((e) => e.pdfName), ['a.pdf', 'b.pdf']);
  assert.equal(store.list()[0].sessionFileName, 'a.ptl');
});

test('the stored list is capped at 12, newest kept', async () => {
  const store = memStore(
    Array.from({ length: 12 }, (_, i) => pentry(`/d/p${i}.pdf`, null, (i + 1) * 10)));
  await recordRecentMerged(pentry('/d/new.pdf', null, 1000), store.io);
  assert.equal(store.list().length, 12);
  assert.equal(store.list()[0].pdfName, 'new.pdf');
  assert.ok(!store.list().some((e) => e.pdfName === 'p0.pdf'), 'the oldest dropped');
});

test('removal targets one pair and keeps concurrent additions', async () => {
  // Window 2 added c.pdf after window 1 last read; window 1 removes a.pdf.
  const store = memStore([
    pentry('/d/a.pdf', '/d/a.ptl', 100),
    pentry('/d/b.pdf', null, 200),
    pentry('/d/c.pdf', null, 300),
  ]);
  await removeRecentMerged(pentry('/d/a.pdf', '/d/a.ptl', 100), store.io);
  assert.deepEqual(store.list().map((e) => e.pdfName).sort(), ['b.pdf', 'c.pdf']);
});

test('removal matches the whole pair: same PDF, other session stays', async () => {
  const store = memStore([
    pentry('/d/paper.pdf', '/d/draft.ptl', 100),
    pentry('/d/paper.pdf', '/d/final.ptl', 200),
  ]);
  await removeRecentMerged(pentry('/d/paper.pdf', '/d/draft.ptl', 100), store.io);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].sessionFileName, 'final.ptl');
});
