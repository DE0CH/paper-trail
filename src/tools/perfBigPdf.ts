// Generates sample/perf-big.pdf — a large, text-heavy document for the
// hot-path profiler (perfHot). Real extractable text (StandardFont), lots
// of repeated words so the search index has plenty of matches. Not committed;
// generated in CI before profiling. Usage: node build-node/tools/perfBigPdf.js [pages]
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'sample', 'perf-big.pdf');
const PAGES = Number(process.argv[2] ?? 600);

const WORDS = [
  'category', 'morphism', 'functor', 'lemma', 'theorem', 'proof', 'object',
  'inner', 'product', 'positive', 'cone', 'tensor', 'Hilbert', 'space',
  'algebra', 'equivariant', 'definition', 'bilinear', 'the', 'and', 'of',
  'is', 'completeness', 'generators', 'dual', 'adjoint', 'norm', 'section',
];

async function main(): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  let seed = 1;
  for (let p = 0; p < PAGES; p++) {
    const page = doc.addPage([612, 792]);
    let y = 740;
    for (let line = 0; line < 45; line++) {
      const words: string[] = [];
      for (let w = 0; w < 12; w++) words.push(WORDS[(seed++ * 7) % WORDS.length]);
      page.drawText(`p${p + 1} ${words.join(' ')}`,
        { x: 54, y, size: 11, font, color: rgb(0.1, 0.1, 0.12) });
      y -= 16;
    }
  }
  const bytes = await doc.save();
  fs.writeFileSync(OUT, bytes);
  console.log(`wrote ${OUT}  ${(bytes.length / 1048576).toFixed(1)}MB  ${PAGES} pages`);
}

main().catch((e) => { console.error(e); process.exit(1); });
