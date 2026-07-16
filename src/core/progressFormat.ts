// Reading-progress file format: a line-oriented plain-text format designed
// to produce small, semantically clear git diffs (one history entry per
// line; appending an entry is a one-line diff). Example:
//
//   paper-trail-session v2
//   pdf.name WStarCats.pdf
//   view.scale 1.2745098
//   view.fitWidth true
//   view.page 17
//   view.yRatio 0.42021803
//   active 0
//
//   stack RoundTrip
//   cursor 1
//   entry 8 0.29980178 Start
//   named 17 0.42 my own label
//
// `entry` lines carry automatic labels; `named` marks a label the user
// typed by hand (re-anchoring refreshes automatic labels only).
//
// The PDF is identified by its NAME alone — deliberately no fingerprints,
// hashes, or paths, so the file holds nothing the user can't see and
// control. Stacks are an ordered list; `active` is the 0-based position
// of the active one. Free-text values (stack names, entry labels) go last on
// their line so no escaping is needed; newlines are flattened on save.
// Internal ids are assigned on load — they never appear in the file.
//
// v2 records no time: v1's `saved <ISO date>` line changed on every save
// and polluted git diffs with timestamp churn. Files loaded as v1 are
// saved back as v1 with their recorded time untouched (frozen verbatim,
// or still absent if the file never had one) — the time is never edited.

import type { HistStack, ProgressFile } from './types';

export const PROGRESS_HEADER = 'paper-trail-session v2';
const PROGRESS_HEADER_V1 = 'paper-trail-session v1';
export const PROGRESS_EXT = '.ptl';

/**
 * The format version this build writes for new sessions. The header line
 * (`paper-trail-session v<N>`) exists so the format can evolve: files
 * from a newer major are refused with a clear message instead of being
 * misread, and older ones stay readable — every version from
 * PROGRESS_VERSION_MIN on parses, and a file keeps the version it was
 * loaded with when saved back.
 */
export const PROGRESS_VERSION = 2;
export const PROGRESS_VERSION_MIN = 1;

/**
 * The version a session file declares in its header, or null when the
 * text is not a session file at all.
 */
export function progressVersion(text: string): number | null {
  const m = (text.split(/\r?\n/, 1)[0] ?? '').trim().match(/^paper-trail-session v(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

const line = (s: string) => s.replace(/[\r\n]+/g, ' ').trimEnd();

export function serializeProgress(p: ProgressFile): string {
  const activeIndex = Math.max(
    0,
    p.state.hist.stacks.findIndex((s) => s.id === p.state.hist.activeId),
  );
  const out: string[] = [];
  if (p.v === 1) {
    // A file loaded as v1 is saved back as v1, and its recorded time is
    // never edited: the loaded value round-trips verbatim, and a v1 file
    // that never had a saved line doesn't gain one.
    out.push(PROGRESS_HEADER_V1);
    if (p.savedRaw !== undefined) out.push(`saved ${p.savedRaw}`);
  } else {
    out.push(PROGRESS_HEADER); // v2 records no time at all
  }
  out.push(`pdf.name ${line(p.pdf.name)}`);
  out.push(`view.scale ${p.state.scale}`);
  out.push(`view.fitWidth ${p.state.fitWidth}`);
  out.push(`view.page ${p.state.pos.page}`);
  out.push(`view.yRatio ${p.state.pos.yRatio}`);
  out.push(`active ${activeIndex}`);
  for (const s of p.state.hist.stacks) {
    out.push('');
    out.push(`stack ${line(s.name)}`);
    out.push(`cursor ${s.index}`);
    for (const e of s.entries) {
      out.push(`${e.edited ? 'named' : 'entry'} ${e.pos.page} ${e.pos.yRatio} ${line(e.label)}`);
    }
  }
  out.push('');
  return out.join('\n');
}

export function parseProgress(text: string): ProgressFile | null {
  const kv: Record<string, string> = {};
  const stacks: HistStack[] = [];
  let cur: HistStack | null = null;

  // Everything from the first character on is inside the try: this
  // boundary receives file contents, and garbage of ANY shape (even a
  // non-string) must come back as null, never as a throw.
  try {
    const lines = text.split(/\r?\n/);
    const ver = progressVersion(text);
    if (ver === null || ver < PROGRESS_VERSION_MIN || ver > PROGRESS_VERSION) return null;

    for (const raw of lines.slice(1)) {
      if (!raw.trim()) continue;
      const sp = raw.indexOf(' ');
      const key = sp === -1 ? raw : raw.slice(0, sp);
      const rest = sp === -1 ? '' : raw.slice(sp + 1);
      if (key === 'stack') {
        cur = {
          id: stacks.length + 1,
          name: rest || `Untitled ${stacks.length + 1}`,
          index: 0,
          entries: [],
        };
        stacks.push(cur);
      } else if (key === 'cursor') {
        if (cur) cur.index = parseInt(rest, 10) | 0;
      } else if (key === 'entry' || key === 'named') {
        if (!cur) return null;
        const m = rest.match(/^(\d+) (\S+)(?: (.*))?$/);
        if (!m) return null;
        cur.entries.push({
          label: m[3] ?? '',
          pos: { page: parseInt(m[1], 10), yRatio: Number(m[2]) },
          ...(key === 'named' ? { edited: true } : {}),
        });
      } else {
        kv[key] = rest;
      }
    }

    if (!stacks.length) return null;
    for (const s of stacks) {
      if (!s.entries.length) return null;
      s.index = Math.min(Math.max(s.index, 0), s.entries.length - 1);
    }
    const activeIndex = Math.min(
      Math.max(parseInt(kv['active'] ?? '0', 10) | 0, 0),
      stacks.length - 1,
    );
    // "Untitled N" numbering continues after the highest one in the file.
    let maxUntitled = 0;
    for (const s of stacks) {
      const m = s.name.match(/^Untitled (\d+)$/);
      if (m) maxUntitled = Math.max(maxUntitled, parseInt(m[1], 10));
    }
    return {
      type: 'pdf-stack-reader-progress',
      v: ver as 1 | 2,
      savedAt: Date.parse(kv['saved'] ?? '') || Date.now(),
      // v1's recorded time, kept verbatim so saving the file back never
      // edits it (v2 files carry none; a stray `saved` line is ignored).
      ...(ver === 1 && kv['saved'] !== undefined ? { savedRaw: kv['saved'] } : {}),
      // Older files carry pdf.relPath / pdf.fingerprint / pdf.size lines;
      // they land in kv and are deliberately ignored.
      pdf: { name: kv['pdf.name'] ?? '' },
      state: {
        v: 1,
        name: kv['pdf.name'] ?? '',
        scale: Number(kv['view.scale']) || 1,
        fitWidth: kv['view.fitWidth'] !== 'false',
        pos: {
          page: parseInt(kv['view.page'] ?? '1', 10) || 1,
          yRatio: Number(kv['view.yRatio']) || 0,
        },
        hist: {
          v: 3,
          activeId: stacks[activeIndex].id,
          nameCounter: Math.max(maxUntitled + 1, stacks.length + 1),
          stacks,
        },
        ts: Date.now(),
      },
    };
  } catch {
    return null;
  }
}
