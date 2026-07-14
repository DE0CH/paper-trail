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
    sessionFileHandle: session,
    pdfName: pdf.name,
    sessionFileName: session ? session.name : '',
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
    pdfHandle: pdf, sessionFileHandle: s,
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
    pdfHandle: fh('paper.pdf'), sessionFileHandle: fh('draft.ptl'),
    pdfName: 'paper.pdf', sessionFileName: 'draft.ptl', timestamp: 100,
  };
  const e2: RecentEntry = {
    pdfHandle: fh('paper.pdf'), sessionFileHandle: fh('final.ptl'),
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
