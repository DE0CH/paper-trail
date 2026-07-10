const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  await p.goto('http://127.0.0.1:8377/?file=sample/WStarCats.pdf');
  await p.waitForSelector('.page[data-page="1"] .annotLayer .pdfLink', { timeout: 20000 });
  // build a couple of history entries + a fork for full sidebar context
  await p.evaluate(async () => {
    const psr = window.__psr;
    psr.jumpVia({ page: 22, yRatio: 0.1 }, 'Definition 4.1');
    psr.jumpVia({ page: 5, yRatio: 0.3 }, 'Lemma 2.3');
  });
  await p.waitForTimeout(600);
  await p.screenshot({ path: '/tmp/psr-ui.png', clip: { x: 0, y: 0, width: 700, height: 700 } });
  // outline computed styles vs history row styles
  const styles = await p.evaluate(() => {
    const o = document.querySelector('.outlineItem');
    const h = document.querySelector('.histItem');
    const ul = document.querySelector('#outlinePanel .outline');
    const pick = (el) => {
      const cs = getComputedStyle(el);
      return { padding: cs.padding, margin: cs.margin, font: cs.fontSize, lh: cs.lineHeight, border: cs.border, outline: cs.outline, background: cs.backgroundColor };
    };
    return { outlineItem: o ? pick(o) : null, histItem: h ? pick(h) : null, outlineUl: ul ? pick(ul) : null };
  });
  console.log(JSON.stringify(styles, null, 1));
  await b.close();
})();
