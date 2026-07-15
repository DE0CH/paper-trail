// Turning a second process's argv into files to open. Pure aside from
// the existence check — unit-tested without Electron.

import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * The file arguments carried by a second process's argv. Relative paths
 * are resolved against the SECOND process's working directory (Electron
 * hands it to the 'second-instance' handler): resolving them against
 * our own cwd would find nothing — or worse, an unrelated same-named
 * file next to the app. When no usable directory arrives (packaged
 * launches, tests emitting the event directly), the argv entries pass
 * through unchanged — OS launchers send absolute paths there.
 */
export function resolveFileArgs(argv: string[], workingDirectory?: unknown): string[] {
  const cwd = typeof workingDirectory === 'string' && workingDirectory
    ? workingDirectory : null;
  return argv
    .filter((a) => /\.(pdf|ptl)$/i.test(a))
    .map((a) => (cwd ? path.resolve(cwd, a) : a))
    .filter((a) => {
      try { return fs.existsSync(a); } catch { return false; }
    });
}
