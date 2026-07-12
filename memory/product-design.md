# Paper Trail: product/design facts (from early development)

User-facing name: "Paper Trail"; UI says "trails", never "stacks"
(technical terms stay internal). PDF reader: parallel history trails
(browser back/forward, cmd+click branches, snapshot undo/redo capped 50
oldest-dropped, entry anchors immutable on scroll — explicit ⌖ re-anchor),
reading-session files (line-oriented plain text, ordered trails,
no ids — user refuses JSON), explicit two-file flow (NO path resolution:
PDF-first + "Load session…" w/ confirm; session-first + prompt; mismatch
banner w/ "Use this PDF"; ⇄ Replace PDF keeps history), page-width
scrollable/resizable hover preview, outline+thumbnails nav panel
(closable, leftmost), independent panel widths (neighbors shift, never
resize), device-pixel-exact rendering (uncapped dpr, 64M px area cap,
backing/css exact ratio), pinch = ctrl+wheel re-render zoom.
Perf limits (measured, unenforced): localStorage auto-resume hard-fails
~63k entries; UI soft-slow ~20k entries in active trail.
- Stack: TS strict + React + Vite + Tailwind v4; pdfjs-dist v6 (npm);
  Electron shell over custom protocol (user: NO TCP in desktop app);
  node server only for browser mode; Python scripts (user: NO shell scripts).
- Build: `npm run build`; test: `npm start` then `npm test` (headless e2e,
  playwright-core, pinned Chromium). README/CONTRIBUTING have details.
- pdfjs v6 gotchas: text layer sized by CSS rules on --font-height/--scale-x/
  --total-scale-factor (globals.css); loadingTask.destroy();
  convertToViewportRectangle removed; getDocument({data}) detaches buffer.
- Test hooks: window.__pt; keep element ids (#stacksPanel, .pdfLink,
  .searchHl, #resizeSidebar...) stable for e2e.
