// While a quit-install is replacing the app's files, a reopen must not
// run from the half-replaced install — it flashes closed and "looks
// corrupt" (owner report). Owner decision (2026-07-13, see
// docs/flash-close-finding.md): a reopen that lands mid-install CANCELS
// the update and brings up the OLD version SILENTLY — no marquee, no
// flash, no error. Called FIRST thing on win32: if the updater's
// pending installer is running, stop it before it replaces our files,
// then let the caller start normally on the intact old version. The
// downloaded update stays in the updater cache and re-applies on the
// next clean quit.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * If a pending update's installer is running right now, stop it so the
 * reopen runs the intact OLD version (the update is deferred to the next
 * quit) and return true. Silent — no window is ever shown. Returns false
 * in every other case, including dev runs (no app-update.yml next to the
 * executable); the caller starts the app normally either way.
 */
export function cancelUpdateOnReopen(exePath: string): boolean {
  try {
    const cfg = fs.readFileSync(
      path.join(path.dirname(exePath), 'resources', 'app-update.yml'), 'utf8');
    const cacheName = /updaterCacheDirName:\s*(\S+)/.exec(cfg)?.[1];
    if (!cacheName) return false;
    const pending = path.join(process.env.LOCALAPPDATA ?? '', cacheName, 'pending');
    if (!fs.existsSync(pending)) return false;
    const installer = fs.readdirSync(pending)
      .find((f) => f.toLowerCase().endsWith('.exe'));
    if (!installer) return false;
    // A reopen right after the quit can land in the gap between the dying
    // app spawning the installer and the process showing up: with a
    // pending installer on disk, look a few times before concluding no
    // install is happening.
    let seen = false;
    for (let attempt = 0; attempt < 3 && !seen; attempt++) {
      if (attempt > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      }
      const list = execFileSync('tasklist',
        ['/FI', `IMAGENAME eq ${installer}`], { encoding: 'utf8', timeout: 15_000 });
      seen = list.toLowerCase().includes(installer.toLowerCase());
    }
    if (!seen) return false;
    // Cancel it: stop the installer before it can replace our files, so
    // the reopen runs the intact OLD version. The download stays cached
    // and re-applies on the next clean quit — no marquee, no relaunch
    // dance, no window.
    execFileSync('taskkill', ['/F', '/IM', installer], { timeout: 15_000 });
    return true;
  } catch {
    return false; // unreadable state: just start normally
  }
}
