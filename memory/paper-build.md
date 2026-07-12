# W*-categories paper: HTML/PDF build notes

## HTML build: run `./build-html.sh` (does everything)
Pipeline inside: make4ht "mathml,mathjax" → fix-mathml.py → head injections
(STRIPS the MathJax script + adds theme toggle). NO MathJax in final output:
MathJax CHTML is not real text (not selectable/searchable even with assistive-mml —
tested and failed). Native MathML IS selectable/searchable/copyable (tested via
Selection API + window.find in headless Chrome — always test, don't assume).
Entry point: html/WStarCats.html. Key facts:
- "mathml,mathjax" mode required (plain "mathjax" passes raw TeX w/ custom macros → fails)
- fix-mathml.py: tex4ht emits raw text nodes in MathML (invisible in browsers,
  rejected by MathJax) → wrap in <mi>/<mn>/<mo>; hoists diagram <img>s out of
  <semantics><annotation-xml> (browsers don't render); upright operator names dict
- Spacing gotchas (all fixed in fix-mathml.py): unknown <mo>s get 0.28em default
  spacing in MathML Core → (1) fences need explicit lspace/rspace 0, (2) Greek
  letters must be <mi> not <mo> (letter regex must be unicode-aware), (3) tex4ht's
  \big( emits an EMPTY <mo> that gets default spacing → BIG_FENCE regex collapses it
- Fonts: Latin Modern Math + Roman .otf bundled in html/ (copied from TeX Live
  opentype dirs), wired via @font-face in theme.css — without them native MathML
  falls back to Times and looks bad
- Typst HTML export evaluated (typst 0.14): DROPS math entirely from HTML output,
  export officially incomplete — dead end, don't revisit until typst math-in-HTML lands
- theme.css/theme.js live in html/, survive rebuilds; theme flips color-scheme
  (body uses Canvas/CanvasText) — must override BOTH :root and body; img invert for SVGs
- Analogies table: source refactored to \analogyrow macros (\ifdefined\HCode) —
  PDF keeps tikz layout (verified identical), HTML emits real <table class='analogies'>
  (searchable/copyable; CSS in theme.css). Only ~14 SVGs remain (genuine diagrams).
NOTE: make4ht also writes outputs to project root (-d only copies); root
WStarCats.html is unfixed/stale — user once got "Math input error" from opening it.

## Source fixes already applied to WStarCats.tex
- Removed `pdftex` option from hyperref (breaks tex4ht's DVI run; pdflatex autodetects)
- `\tworarrow` wrapped in `\ifdefined\HCode` → `\Rightarrow` for HTML builds
  (original is a picture-env drawing, invisible in HTML)
- Renamed 4 labels containing `<`/`>` chars (broke tex4ht anchors)
- `eq: coherence gamma` label: equation* → equation (was genuinely undefined ref, also in PDF)
- Added `\input{glyphtounicode}` + `\pdfgentounicode=1` (PDF search/copy fix)

## PDF build
pdflatex x2 (bibliography embedded, no bibtex). 41 pages.

## Verification technique for HTML rendering (no browser tools available)
- Serve: `python3 -m http.server 8734` in html/ (file:// URLs fail in headless Chrome)
- `Chrome --headless=new --print-to-pdf=... --no-pdf-header-footer URL` then Read the
  PDF pages visually (best method; #anchor/scroll screenshots come out blank)
- MathJax error check: `--virtual-time-budget=30000 --dump-dom` then grep `data-mjx-error`
- headless Chrome renders in dark mode; force light with CSS if screenshotting
