// Prints a markdown table from c8's json-summary output; the CI
// coverage step appends it to the GitHub Actions job summary page.
// Also writes coverage/badge.json (the shields.io endpoint schema),
// which CI publishes as a GitHub Pages deployment — the README's
// coverage badge reads it from there, so the number updates on every
// main push without anything being committed to the repo.
// Run: node build-node/tools/coverageSummary.js  (after npm run coverage)

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Metric { pct: number; covered: number; total: number }

const dir = path.resolve(__dirname, '..', '..', 'coverage');
const summary = JSON.parse(
  fs.readFileSync(path.join(dir, 'coverage-summary.json'), 'utf8')) as {
  total: Record<string, Metric>;
};

console.log('### Unit test coverage (src/core)');
console.log('');
console.log('| Metric | Coverage |');
console.log('| --- | --- |');
for (const metric of ['lines', 'statements', 'functions', 'branches']) {
  const m = summary.total[metric];
  console.log(`| ${metric} | ${m.pct}% (${m.covered}/${m.total}) |`);
}

const pct = summary.total.lines.pct;
fs.writeFileSync(path.join(dir, 'badge.json'), JSON.stringify({
  schemaVersion: 1,
  label: 'unit coverage',
  message: `${pct}%`,
  color: pct >= 90 ? 'brightgreen' : pct >= 75 ? 'green' : pct >= 60 ? 'yellow' : 'red',
}));
