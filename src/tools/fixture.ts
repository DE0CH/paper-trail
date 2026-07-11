// Generates the test-fixture PDF (sample/WStarCats.pdf) that the e2e suite
// runs against. The real paper the app was developed against cannot be
// redistributed, so this synthetic document reproduces the structural
// features the tests rely on:
//   - 41 letter-sized pages with headings, body text, and page numbers
//   - a selectable title line on page 1 (~21.5% from the top)
//   - internal link annotations on page 1; the 4th link covers "4.1" in a
//     "... Definition 4.1 ..." sentence and targets page 22 (so link-label
//     extraction yields "Definition 4.1")
//   - the word "equivariant" appearing exactly 4 times
//   - a 7-entry document outline
// Also generates sample/cjk.pdf: a one-page document whose text uses a
// CID font with the predefined UniGB-UCS2-H encoding and NO embedded
// font program, so pdf.js cannot decode or render it without the
// bundled cMaps — the regression fixture for offline CJK rendering.
// Usage: node build-node/tools/fixture.js [--force]

import { PDFDocument, PDFName, PDFArray, PDFString, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'sample', 'WStarCats.pdf');
const CJK_OUT = path.join(ROOT, 'sample', 'cjk.pdf');

const W = 612;
const H = 792;
const INK = rgb(0.1, 0.1, 0.12);
const DIM = rgb(0.35, 0.35, 0.4);

// The CJK fixture is built by hand at the object level: pdf-lib cannot
// author non-embedded CID fonts, but the whole point is that the file
// carries no font program — only /Encoding /UniGB-UCS2-H — so text
// decoding entirely depends on pdf.js loading the bundled cMaps.
async function writeCjk(): Promise<void> {
  if (fs.existsSync(CJK_OUT) && !process.argv.includes('--force')) {
    console.log('fixture exists:', CJK_OUT);
    return;
  }
  const doc = await PDFDocument.create();
  const page = doc.addPage([W, H]);
  const ctx = doc.context;
  const fdRef = ctx.register(ctx.obj({
    Type: 'FontDescriptor',
    FontName: 'STSong-Light',
    Flags: 4,
    FontBBox: [-25, -254, 1000, 880],
    ItalicAngle: 0,
    Ascent: 880,
    Descent: -254,
    CapHeight: 737,
    StemV: 58,
  }));
  const cidRef = ctx.register(ctx.obj({
    Type: 'Font',
    Subtype: 'CIDFontType0',
    BaseFont: 'STSong-Light',
    CIDSystemInfo: ctx.obj({
      Registry: PDFString.of('Adobe'),
      Ordering: PDFString.of('GB1'),
      Supplement: 4,
    }),
    FontDescriptor: fdRef,
    DW: 1000,
  }));
  const f0Ref = ctx.register(ctx.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'STSong-Light-UniGB-UCS2-H',
    Encoding: 'UniGB-UCS2-H',
    DescendantFonts: [cidRef],
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F0: f0Ref } }));
  // UCS-2 hex strings: 你好世界 / 中文测试：你好 ("你好" appears twice,
  // which the search test counts on).
  const content = [
    'BT /F0 24 Tf 72 712 Td <4F60597D4E16754C> Tj ET',
    'BT /F0 14 Tf 72 672 Td <4E2D65876D4B8BD5FF1A4F60597D> Tj ET',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content)));
  doc.setTitle('CJK rendering fixture');
  const bytes = await doc.save({ useObjectStreams: false });
  fs.writeFileSync(CJK_OUT, bytes);
  console.log('wrote', CJK_OUT, `${Math.round(bytes.length / 1024)}KB, 1 page`);
}

async function run(): Promise<void> {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await writeCjk();
  if (fs.existsSync(OUT) && !process.argv.includes('--force')) {
    console.log('fixture exists:', OUT);
    return;
  }

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);

  const pages = Array.from({ length: 41 }, () => doc.addPage([W, H]));

  const text = (i: number, str: string, x: number, y: number, size = 11, f = font, color = INK) =>
    pages[i].drawText(str, { x, y, size, font: f, color });

  // generic body so every page thumbnails/search/renders sensibly
  const LOREM = 'Let C be a W-category and let a, b be objects with morphisms f : a -> b. '
    + 'The inner product extends along direct sums and completions.';
  for (let i = 0; i < 41; i++) {
    text(i, `Section ${Math.floor(i / 6) + 1}.${(i % 6) + 1}`, 72, H - 80, 14, bold);
    for (let l = 0; l < 9; l++) {
      text(i, LOREM.slice(0, 88 - (l % 3) * 9), 72, H - 130 - l * 26, 11);
    }
    text(i, String(i + 1), W / 2 - 5, 40, 10, font, DIM);
  }

  // ---- page 1 specifics ----
  const p1 = pages[0];
  // clear-ish title band: the selection test drags across ~21.5% from top
  p1.drawRectangle({ x: 60, y: H - 200, width: W - 120, height: 150, color: rgb(1, 1, 1) });
  text(0, 'Complete W-categories: a synthetic test paper', 92, H * (1 - 0.215) - 6, 19, bold);
  text(0, 'A. Author, B. Author, and C. Author', 170, H - 230, 12);

  // link helper: rect in PDF coords (origin bottom-left)
  const link = (pageIdx: number, x: number, y: number, w: number, h: number,
    destIdx: number, destY: number) => {
    const annot = doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      Dest: [pages[destIdx].ref, 'XYZ', null, destY, null],
    });
    const ref = doc.context.register(annot);
    const page = pages[pageIdx];
    let annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) {
      annots = doc.context.obj([]) as PDFArray;
      page.node.set(PDFName.of('Annots'), annots);
    }
    annots.push(ref);
  };

  // paragraph with the reference links (single drawText per sentence so the
  // text layer keeps each sentence as one item — label extraction depends
  // on the "Definition " prefix being in the same item as "4.1")
  const s1 = 'They were introduced in [GLR85], but see also 1 and Yam07 for background.';
  const s1y = H - 320;
  text(0, s1, 72, s1y, 12);
  const wpt = (s: string) => font.widthOfTextAtSize(s, 12);
  link(0, 72 + wpt('They were introduced in ['), s1y - 2, wpt('GLR85'), 14, 38, H - 60);
  link(0, 72 + wpt('They were introduced in [GLR85], but see also '), s1y - 2, wpt('1'), 14, 1, H - 60);
  link(0, 72 + wpt('They were introduced in [GLR85], but see also 1 and '), s1y - 2, wpt('Yam05'), 14, 38, H - 400);

  const s2 = 'This notion is renamed the inner product (Definition 4.1). It is equivariant.';
  const s2y = H - 344;
  text(0, s2, 72, s2y, 12);
  link(0, 72 + wpt('This notion is renamed the inner product (Definition '), s2y - 2,
    wpt('4.1'), 14, 21, H - 60);

  // a couple more links deeper on page 1 (media chain material)
  const s3 = 'Compare Lemma 4.2 and the remarks after Proposition 3.9.';
  const s3y = H - 368;
  text(0, s3, 72, s3y, 12);
  link(0, 72 + wpt('Compare Lemma '), s3y - 2, wpt('4.2'), 14, 22, H - 200);
  link(0, 72 + wpt('Compare Lemma 4.2 and the remarks after Proposition '), s3y - 2,
    wpt('3.9'), 14, 15, H - 100);

  // ---- destination page content (22 = index 21) ----
  text(21, 'Definition 4.1. Every W-category admits a canonical inner product', 72, H - 70, 13, bold);
  text(21, 'which is compatible with direct sums in the following sense.', 72, H - 92, 11);

  // links sprinkled through the document so the demo's dependency chain
  // always finds a next reference — each with a DIFFERENT label, so the
  // chain shows varied, plausible dependencies
  const chain: Array<[number, number, string, string]> = [
    [21, 24, 'Lemma', '5.3'],
    [22, 26, 'Proposition', '6.2'],
    [23, 28, 'Theorem', '2.8'],
    [25, 30, 'Corollary', '7.1'],
    [27, 12, 'Definition', '3.5'],
    [29, 33, 'Remark', '8.4'],
    [15, 21, 'Example', '4.9'],
    [30, 5, 'Equation', '12'],
  ];
  for (const [pg, dest, kind, num] of chain) {
    const sy = H - 260;
    const prefix = `See also ${kind} `;
    text(pg, `${prefix}${num} for the corresponding statement.`, 72, sy, 12);
    link(pg, 72 + wpt(prefix), sy - 2, wpt(num), 14, dest, H - 60);
  }

  // ---- exactly four occurrences of "equivariant" ----
  // (one is on page 1 inside s2 above)
  text(15, 'Every such map is equivariant for the induced action.', 72, H - 300, 11);
  text(16, 'Providing an equivariant map d1 -> d2 is equivalent to a transformation.', 72, H - 300, 11);
  text(29, 'The construction is manifestly equivariant in both variables.', 72, H - 300, 11);

  // ---- outline (7 top-level entries, two with subsections and one
  // sub-subsection — the collapsible-outline tests depend on this shape:
  // 11 nodes total, 3 collapsible, 3 levels deep) ----
  interface ONode { title: string; page: number; kids: ONode[] }
  const o = (title: string, page: number, kids: ONode[] = []): ONode => ({ title, page, kids });
  const outlineNodes: ONode[] = [
    o('Introduction', 0),
    o('Hilbert spaces and algebras', 2),
    o('W-categories: basics', 4),
    o('The inner product', 8, [
      o('Definition and examples', 9, [o('Bilinear forms', 10)]),
      o('Functoriality', 12),
    ]),
    o('Positive cones', 15),
    o('Small W-categories', 21, [o('Generators', 24)]),
    o('Tensor categories', 28),
  ];
  const outlinesRef = doc.context.nextRef();
  const writeLevel = (nodes: ONode[], parentRef: ReturnType<typeof doc.context.nextRef>) => {
    const refs = nodes.map(() => doc.context.nextRef());
    nodes.forEach((node, i) => {
      const kidRefs = node.kids.length ? writeLevel(node.kids, refs[i]) : [];
      doc.context.assign(refs[i], doc.context.obj({
        Title: PDFString.of(node.title),
        Parent: parentRef,
        Dest: [pages[node.page].ref, 'XYZ', null, H, null],
        ...(i > 0 ? { Prev: refs[i - 1] } : {}),
        ...(i < nodes.length - 1 ? { Next: refs[i + 1] } : {}),
        ...(kidRefs.length
          ? { First: kidRefs[0], Last: kidRefs[kidRefs.length - 1], Count: kidRefs.length }
          : {}),
      }));
    });
    return refs;
  };
  const topRefs = writeLevel(outlineNodes, outlinesRef);
  doc.context.assign(outlinesRef, doc.context.obj({
    Type: 'Outlines',
    First: topRefs[0],
    Last: topRefs[topRefs.length - 1],
    Count: outlineNodes.length,
  }));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

  doc.setTitle('Complete W-categories: a synthetic test paper');
  const bytes = await doc.save({ useObjectStreams: false });
  fs.writeFileSync(OUT, bytes);
  console.log('wrote', OUT, `${Math.round(bytes.length / 1024)}KB, 41 pages`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
