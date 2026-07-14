// Unit tests for the recents pair-list logic (updateRecent + buildDisplayList).
// Pure logic, fake handles — no browser. Run: node --test build-node/test/recentsUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateRecent, buildDisplayList, type RecentEntry } from '../core/recents';

// A fake FileSystemFileHandle: identity via a private id, name for display.
let idc = 0;
function fh(name: string): FileSystemFileHandle {
  const id = ++idc;
  return {
    name,
    kind: 'file',
    isSameEntry: async (o: unknown) =>
      !!o && (o as { __id?: number }).__id === id,
    __id: id,
  } as unknown as FileSystemFileHandle;
}

function entry(
  pdf: FileSystemFileHandle,
  session: FileSystemFileHandle | null,
  ts: number,
): RecentEntry {
  return {
    pdfHandle: pdf,
    pdfPath: null,
    sessionFileHandle: session,
    sessionPath: null,
    pdfName: pdf.name,
    sessionFileName: session ? session.name : '',
    timestamp: ts,
  };
}

// A path-identity entry (desktop opens with no handle), keyed on on-disk paths.
function pentry(
  pdfPath: string,
  sessionPath: string | null,
  ts: number,
): RecentEntry {
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  return {
    pdfHandle: null,
    pdfPath,
    sessionFileHandle: null,
    sessionPath,
    pdfName: base(pdfPath),
    sessionFileName: sessionPath ? base(sessionPath) : '',
    timestamp: ts,
  };
}

// ---- updateRecent -------------------------------------------------------

test('updateRecent: empty list gets the new entry', async () => {
  const list = await updateRecent([], entry(fh('a.pdf'), fh('a.ptl'), 100));
  assert.equal(list.length, 1);
  assert.equal(list[0].timestamp, 100);
});

test('updateRecent: exact pair match refreshes timestamp + names, no new row', async () => {
  const pdf = fh('a.pdf'); const s = fh('a.ptl');
  const list = [entry(pdf, s, 100)];
  await updateRecent(list, {
    pdfHandle: pdf, pdfPath: null, sessionFileHandle: s, sessionPath: null,
    pdfName: 'renamed.pdf', sessionFileName: 'renamed.ptl', timestamp: 200,
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].timestamp, 200);
  assert.equal(list[0].pdfName, 'renamed.pdf');
  assert.equal(list[0].sessionFileName, 'renamed.ptl');
});

test('updateRecent: first save upgrades the (pdf, null) row in place', async () => {
  const pdf = fh('a.pdf'); const s = fh('a.ptl');
  const list = [entry(pdf, null, 100)];
  await updateRecent(list, entry(pdf, s, 200));
  assert.equal(list.length, 1, 'no duplicate row for the same pdf');
  assert.ok(list[0].sessionFileHandle, 'null session slot was upgraded');
  assert.equal(list[0].sessionFileName, 'a.ptl');
  assert.equal(list[0].timestamp, 200);
});

test('updateRecent: a different pdf makes a new row (no upgrade)', async () => {
  const list = [entry(fh('a.pdf'), null, 100)];
  await updateRecent(list, entry(fh('b.pdf'), fh('b.ptl'), 200));
  assert.equal(list.length, 2);
});

test('updateRecent: incoming null session matching (pdf, null) just bumps', async () => {
  const pdf = fh('a.pdf');
  const list = [entry(pdf, null, 100)];
  await updateRecent(list, entry(pdf, null, 200));
  assert.equal(list.length, 1);
  assert.equal(list[0].timestamp, 200);
});

test('updateRecent: incoming null session, no match, makes a new (pdf,null) row', async () => {
  const list = [entry(fh('a.pdf'), null, 100)];
  await updateRecent(list, entry(fh('b.pdf'), null, 200));
  assert.equal(list.length, 2);
});

// ---- path identity (desktop opens with no handle) ----------------------

test('updateRecent: path-based first save upgrades the (pdfPath, null) row', async () => {
  const list = [pentry('/docs/a.pdf', null, 100)];
  await updateRecent(list, pentry('/docs/a.pdf', '/docs/a.ptl', 200));
  assert.equal(list.length, 1, 'no duplicate row for the same pdf path');
  assert.equal(list[0].sessionPath, '/docs/a.ptl', 'null session slot upgraded by path');
  assert.equal(list[0].sessionFileName, 'a.ptl');
  assert.equal(list[0].timestamp, 200);
});

test('updateRecent: path exact-pair match refreshes, no new row', async () => {
  const list = [pentry('/d/a.pdf', '/d/a.ptl', 100)];
  await updateRecent(list, pentry('/d/a.pdf', '/d/a.ptl', 200));
  assert.equal(list.length, 1);
  assert.equal(list[0].timestamp, 200);
});

test('updateRecent: a path-only session does NOT upgrade a handle-keyed pdf row', async () => {
  const list = [entry(fh('a.pdf'), null, 100)]; // pdf keyed by HANDLE
  await updateRecent(list, pentry('/other/a.pdf', '/other/a.ptl', 200)); // path-keyed
  assert.equal(list.length, 2, 'handle-keyed and path-keyed pdfs stay distinct rows');
});

test('updateRecent: different pdf paths make distinct rows', async () => {
  const list = [pentry('/d/a.pdf', null, 100)];
  await updateRecent(list, pentry('/d/b.pdf', '/d/b.ptl', 200));
  assert.equal(list.length, 2);
});

// ---- buildDisplayList ---------------------------------------------------

test('buildDisplayList: sorts by timestamp descending', () => {
  const e1 = entry(fh('a.pdf'), null, 100);
  const e2 = entry(fh('b.pdf'), null, 300);
  const e3 = entry(fh('c.pdf'), null, 200);
  const disp = buildDisplayList([e1, e2, e3]);
  assert.deepEqual(disp.map((d) => d.entry.timestamp), [300, 200, 100]);
});

test('buildDisplayList: distinct pdf names show just the pdf name', () => {
  const e1 = entry(fh('a.pdf'), fh('x.ptl'), 100);
  const e2 = entry(fh('b.pdf'), fh('y.ptl'), 200);
  const disp = buildDisplayList([e1, e2]);
  assert.equal(disp.find((d) => d.entry === e1)!.text, 'a.pdf');
  assert.equal(disp.find((d) => d.entry === e2)!.text, 'b.pdf');
});

test('buildDisplayList: a shared pdf name appends the session name to both', () => {
  const e1: RecentEntry = {
    pdfHandle: fh('paper.pdf'), pdfPath: null, sessionFileHandle: fh('draft.ptl'), sessionPath: null,
    pdfName: 'paper.pdf', sessionFileName: 'draft.ptl', timestamp: 100,
  };
  const e2: RecentEntry = {
    pdfHandle: fh('paper.pdf'), pdfPath: null, sessionFileHandle: fh('final.ptl'), sessionPath: null,
    pdfName: 'paper.pdf', sessionFileName: 'final.ptl', timestamp: 200,
  };
  const disp = buildDisplayList([e1, e2]);
  assert.equal(disp.find((d) => d.entry === e1)!.text, 'paper.pdf — draft.ptl');
  assert.equal(disp.find((d) => d.entry === e2)!.text, 'paper.pdf — final.ptl');
});

test('buildDisplayList: shared pdf name with no session names stays ambiguous (give up)', () => {
  const e1 = entry(fh('paper.pdf'), null, 100); // sessionFileName ''
  const e2 = entry(fh('paper.pdf'), null, 200);
  const disp = buildDisplayList([e1, e2]);
  assert.equal(disp.find((d) => d.entry === e1)!.text, 'paper.pdf');
  assert.equal(disp.find((d) => d.entry === e2)!.text, 'paper.pdf');
});
