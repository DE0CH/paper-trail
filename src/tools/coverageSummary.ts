// Prints a markdown table from c8's json-summary output; the CI
// coverage step appends it to the GitHub Actions job summary page.
// Run: node build-node/tools/coverageSummary.js  (after npm run coverage)

import * as fs from 'node:fs';
import * as path from 'node:path';

interface Metric { pct: number; covered: number; total: number }

const file = path.resolve(__dirname, '..', '..', 'coverage', 'coverage-summary.json');
const summary = JSON.parse(fs.readFileSync(file, 'utf8')) as {
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
