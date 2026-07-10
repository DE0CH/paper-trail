// Reading-progress file format: a line-oriented plain-text format designed
// to produce small, semantically clear git diffs (one history entry per
// line; appending an entry is a one-line diff). Example:
//
//   psr-progress v1
//   saved 2026-07-10T12:34:56.000Z
//   pdf.name WStarCats.pdf
//   pdf.relPath WStarCats.pdf
//   pdf.fingerprint dcc474819b461982e1882557a8baa4fa
//   pdf.size 547247
//   view.scale 1.2745098
//   view.fitWidth true
//   view.page 17
//   view.yRatio 0.42021803
//   hist.active 1
//   hist.nameCounter 2
//
//   stack 1 RoundTrip
//   cursor 1
//   entry 8 0.29980178 Start
//   entry 17 0.42 Lemma test-marker
//
// Free-text values (stack names, entry labels) go last on their line so no
// escaping is needed; they must not contain newlines.

import type { HistStack, ProgressFile } from './types';

export const PROGRESS_HEADER = 'psr-progress v1';
export const PROGRESS_EXT = '.psr';

const line = (s: string) => s.replace(/[\r\n]+/g, ' ').trimEnd();

export function serializeProgress(p: ProgressFile): string {
  const out: string[] = [];
  out.push(PROGRESS_HEADER);
  out.push(`saved ${new Date(p.savedAt).toISOString()}`);
  out.push(`pdf.name ${line(p.pdf.name)}`);
  out.push(`pdf.relPath ${line(p.pdf.relPath)}`);
  out.push(`pdf.fingerprint ${p.pdf.fingerprint ?? '-'}`);
  out.push(`pdf.size ${p.pdf.size}`);
  out.push(`view.scale ${p.state.scale}`);
  out.push(`view.fitWidth ${p.state.fitWidth}`);
  out.push(`view.page ${p.state.pos.page}`);
  out.push(`view.yRatio ${p.state.pos.yRatio}`);
  out.push(`hist.active ${p.state.hist.activeId}`);
  out.push(`hist.nameCounter ${p.state.hist.nameCounter}`);
  for (const s of p.state.hist.stacks) {
    out.push('');
    out.push(`stack ${s.id} ${line(s.name)}`);
    out.push(`cursor ${s.index}`);
    for (const e of s.entries) {
      out.push(`entry ${e.pos.page} ${e.pos.yRatio} ${line(e.label)}`);
    }
  }
  out.push('');
  return out.join('\n');
}

export function parseProgress(text: string): ProgressFile | null {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== PROGRESS_HEADER) return null;

  const kv: Record<string, string> = {};
  const stacks: HistStack[] = [];
  let cur: HistStack | null = null;

  try {
    for (const raw of lines.slice(1)) {
      if (!raw.trim()) continue;
      const sp = raw.indexOf(' ');
      const key = sp === -1 ? raw : raw.slice(0, sp);
      const rest = sp === -1 ? '' : raw.slice(sp + 1);
      if (key === 'stack') {
        const sp2 = rest.indexOf(' ');
        const id = parseInt(sp2 === -1 ? rest : rest.slice(0, sp2), 10);
        const name = sp2 === -1 ? '' : rest.slice(sp2 + 1);
        cur = { id, name: name || `Untitled ${id}`, index: 0, entries: [] };
        stacks.push(cur);
      } else if (key === 'cursor') {
        if (cur) cur.index = parseInt(rest, 10) | 0;
      } else if (key === 'entry') {
        if (!cur) return null;
        const m = rest.match(/^(\d+) (\S+)(?: (.*))?$/);
        if (!m) return null;
        cur.entries.push({
          label: m[3] ?? '',
          pos: { page: parseInt(m[1], 10), yRatio: Number(m[2]) },
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
    const activeId = parseInt(kv['hist.active'] ?? '', 10);
    return {
      type: 'pdf-stack-reader-progress',
      v: 1,
      savedAt: Date.parse(kv['saved'] ?? '') || Date.now(),
      pdf: {
        name: kv['pdf.name'] ?? '',
        relPath: kv['pdf.relPath'] || kv['pdf.name'] || '',
        fingerprint: kv['pdf.fingerprint'] === '-' ? null : (kv['pdf.fingerprint'] ?? null),
        size: parseInt(kv['pdf.size'] ?? '0', 10) || 0,
      },
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
          activeId: stacks.some((s) => s.id === activeId) ? activeId : stacks[0].id,
          nameCounter: parseInt(kv['hist.nameCounter'] ?? '', 10) || stacks.length + 1,
          stacks,
        },
        ts: Date.now(),
      },
    };
  } catch {
    return null;
  }
}
