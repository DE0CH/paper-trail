// Unit tests for the desktop shell's pure helpers:
//   - placeWindow: remembered bounds are only restored onto a display
//     that is still connected (monitor-unplug protection);
//   - resolveFileArgs: a second process's relative file arguments
//     resolve against ITS working directory, not the first instance's.
// Run: node --test build-node/test/desktopShellUnit.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { placeWindow, type Rect } from '../desktop/windowPlacement';
import { resolveFileArgs } from '../desktop/openArgs';

const laptop: Rect = { x: 0, y: 0, width: 1440, height: 900 };
const external: Rect = { x: 1440, y: -200, width: 2560, height: 1440 };

test('a position on a connected display is restored verbatim', () => {
  assert.deepEqual(
    placeWindow({ x: 100, y: 80, width: 900, height: 640 }, [laptop]),
    { x: 100, y: 80, width: 900, height: 640 });
});

test('a position on a secondary display is restored verbatim', () => {
  assert.deepEqual(
    placeWindow({ x: 2000, y: 120, width: 900, height: 640 }, [laptop, external]),
    { x: 2000, y: 120, width: 900, height: 640 });
});

test('a position left behind by an unplugged monitor is dropped, the size kept', () => {
  assert.deepEqual(
    placeWindow({ x: 2000, y: 120, width: 900, height: 640 }, [laptop]),
    { width: 900, height: 640 });
});

test('a position with no display at all is dropped', () => {
  assert.deepEqual(
    placeWindow({ x: 20000, y: 20000, width: 800, height: 560 }, [laptop]),
    { width: 800, height: 560 });
});

test('a window straddling the display edge keeps its position (still grabbable)', () => {
  assert.deepEqual(
    placeWindow({ x: -300, y: 40, width: 900, height: 640 }, [laptop]),
    { x: -300, y: 40, width: 900, height: 640 });
});

test('a sliver thinner than a grabbable margin does not count as visible', () => {
  // Only 10px of the window overlap the display: unusable.
  assert.deepEqual(
    placeWindow({ x: 1430, y: 40, width: 900, height: 640 }, [laptop]),
    { width: 900, height: 640 });
});

test('saved size without a position passes through untouched', () => {
  assert.deepEqual(
    placeWindow({ width: 1440, height: 940 }, [laptop]),
    { width: 1440, height: 940 });
});

test('relative file arguments resolve against the second process cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-args-'));
  fs.writeFileSync(path.join(dir, 'doc.pdf'), 'x');
  assert.deepEqual(
    resolveFileArgs(['paper-trail', 'doc.pdf'], dir),
    [path.join(dir, 'doc.pdf')]);
});

test('absolute file arguments are untouched by the working directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-args-'));
  const abs = path.join(dir, 'doc.pdf');
  fs.writeFileSync(abs, 'x');
  assert.deepEqual(
    resolveFileArgs(['paper-trail', abs], '/somewhere/else'), [abs]);
});

test('a missing file is dropped even after resolution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-args-'));
  assert.deepEqual(resolveFileArgs(['paper-trail', 'gone.pdf'], dir), []);
});

test('non-document arguments never count as files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-args-'));
  fs.writeFileSync(path.join(dir, 'doc.txt'), 'x');
  assert.deepEqual(
    resolveFileArgs(['paper-trail', '--new-window', 'doc.txt'], dir), []);
});

test('without a usable working directory the arguments pass through as-is', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-args-'));
  const abs = path.join(dir, 'doc.pdf');
  fs.writeFileSync(abs, 'x');
  // Tests and odd launchers hand a non-string; packaged Windows opens
  // send absolute paths, which must keep working unchanged.
  assert.deepEqual(resolveFileArgs(['paper-trail', abs], {}), [abs]);
  assert.deepEqual(resolveFileArgs(['paper-trail', abs], undefined), [abs]);
  assert.deepEqual(resolveFileArgs(['paper-trail', 'doc.pdf'], {}), []);
});
