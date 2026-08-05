// Unit tests for the ptopen CLI (src/tools/ptopen.py): given only a
// session file, it must hand the session's named PDF to the app
// alongside the .ptl — the app deliberately never guesses filesystem
// paths, so a lone .ptl otherwise opens a window with no PDF in it.
// The .ptl format makes the companion determined, not guessed: pdf.name
// records the PDF's bare filename and the pair live side by side.
// Everything runs headlessly through --dry-run (no app launch).
// Run: node --test build-node/test/ptopenPairUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('src/tools/ptopen.py');

function runPtopen(args: string[]): {
  status: number | null; stdout: string; stderr: string;
} {
  const r = spawnSync('python3', [script, '--dry-run', ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A minimal well-formed v2 session naming `pdfName` as its PDF. */
function writeSession(dir: string, pdfName: string): string {
  const ptl = path.join(dir, 'paper.ptl');
  fs.writeFileSync(ptl, [
    'paper-trail-session v2',
    `pdf.name ${pdfName}`,
    'view.scale 1.5',
    'view.fitWidth false',
    'view.page 1',
    'view.yRatio 0',
    'active 0',
    '',
    'stack Trail',
    'cursor 0',
    'named 1 0 Start',
    '',
  ].join('\n'));
  return ptl;
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptopen-'));
}

test('a lone .ptl opens together with its named PDF from the same folder', () => {
  const dir = tmpdir();
  const ptl = writeSession(dir, 'paper.pdf');
  fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-1.4\n');

  const r = runPtopen([ptl]);
  assert.equal(r.status, 0, `exit 0, got ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes('paper.ptl'), `session in command: ${r.stdout}`);
  assert.ok(
    r.stdout.includes(path.join(dir, 'paper.pdf')),
    `the session's named PDF is handed to the app too: ${r.stdout}`,
  );
});

test('a lone .ptl whose named PDF is absent opens alone, with a warning', () => {
  const dir = tmpdir();
  const ptl = writeSession(dir, 'missing.pdf');

  const r = runPtopen([ptl]);
  assert.equal(r.status, 0, `still opens (adoption path), got ${r.status}: ${r.stderr}`);
  assert.ok(r.stdout.includes('paper.ptl'), `session in command: ${r.stdout}`);
  assert.ok(
    !r.stdout.includes('missing.pdf'),
    `no nonexistent path in the command: ${r.stdout}`,
  );
  assert.match(r.stderr, /missing\.pdf/, 'the warning names the absent PDF');
});

test('an explicit session+PDF pair passes through unchanged', () => {
  const dir = tmpdir();
  const ptl = writeSession(dir, 'other.pdf');
  const pdf = path.join(dir, 'other.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n');

  const r = runPtopen([ptl, pdf]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('paper.ptl'), `session in command: ${r.stdout}`);
  assert.ok(r.stdout.includes('other.pdf'), `given PDF in command: ${r.stdout}`);
  assert.equal(r.stderr.trim(), '', 'no warning when names agree');
});

test('the app is targeted by path or bundle id, never by bare name', () => {
  // `open -a "Paper Trail"` resolves by NAME, which is ambiguous: dev
  // builds in the repo and Parallels-shared Windows apps register under
  // the same name, and LaunchServices once handed the files to the VM
  // wrapper. The command must pin the app — the canonical install path
  // if present, else the bundle id — so the files can only land in the
  // real app.
  const dir = tmpdir();
  const ptl = writeSession(dir, 'paper.pdf');
  fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-1.4\n');

  const r = runPtopen([ptl]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    !/-a Paper Trail(?!\.app)|-a 'Paper Trail'(?!\S)/.test(r.stdout),
    `no bare-name -a targeting: ${r.stdout}`,
  );
  assert.ok(
    r.stdout.includes('/Applications/Paper Trail.app')
      || r.stdout.includes('-b local.paper-trail'),
    `pinned to the canonical path or bundle id: ${r.stdout}`,
  );
});

test('an explicit pair with a different name still warns about the mismatch banner', () => {
  const dir = tmpdir();
  const ptl = writeSession(dir, 'named.pdf');
  const pdf = path.join(dir, 'given.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n');

  const r = runPtopen([ptl, pdf]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('given.pdf'), `given PDF still opens: ${r.stdout}`);
  assert.match(r.stderr, /named\.pdf/, 'mismatch warning survives the fix');
});
