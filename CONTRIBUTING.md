# Contributing / developer notes

## Stack

TypeScript (strict) throughout. React + Vite + Tailwind CSS v4 for the
UI; pdf.js (`pdfjs-dist` v6) for rendering; Electron for the desktop
shell; Python for the helper scripts. No hand-vendored code.

Naming convention: technical terms (stack, fork, session internals) stay
in the code; the UI and docs say *trail*, *branch*, *reading session*.
The user-facing product name is **Paper Trail**; the package keeps the
internal name.

## Architecture

```
index.html, vite.config.ts   Vite entry
src/core/                    framework-agnostic app core:
  viewer.ts                    imperative pdf.js viewer (lazy page windowing,
                               text/annotation layers, zoom, link labels)
  history.ts                   NavStacks: list of history stacks + snapshot undo
  search.ts                    full-text search, Range-based highlights
  preview.ts                   hover preview popup
  progressFormat.ts            .trail serializer/parser
  store.ts                     localStorage state, IndexedDB recents/handles
  controller.ts                everything wired together; owns all state
src/ui/                      React components; subscribe to the controller
                             snapshot via useSyncExternalStore
src/node/server.ts           static server for browser use (127.0.0.1 only)
src/desktop/                 Electron shell: paper-trail:// protocol, native menus,
                             minimal contextBridge (menu actions only)
src/test/e2e.ts              end-to-end suite        (npm test)
src/test/perf.ts             performance profiler    (npm run perf)
desktop/launch.py            build-if-needed + serve + open browser
desktop/make_app.py          generate the macOS .app bundle
```

The core is imperative and owns all state; React renders an immutable
snapshot (`controller.getSnapshot()`) and calls controller methods. pdf.js
canvases/text layers are non-React DOM inside a ref.

## Build, run, test

```sh
npm run dev        # Vite dev server (hot reload) on :5173
npm run build      # typecheck web (noEmit) + vite build → dist-web
                   # + tsc → build-node (server, electron, tests)
npm start          # serve dist-web at http://127.0.0.1:8377
npm run desktop    # Electron shell (loads dist-web over paper-trail://)

npm test           # e2e suite — needs `npm start` running
npm run perf       # performance profile + limit search
```

The e2e suite (playwright-core) launches a **separate headless
Edge/Chrome** with its own profile — it never touches your browsing
session. It emulates a user: clicking PDF links, dragging dividers and
text selections, pinch (ctrl+wheel) bursts, keyboard shortcuts — and
asserts outcomes down to device-pixel-exact canvas geometry and
pinch-release position deltas. Keep element ids/classes (`#stacksPanel`,
`.pdfLink`, `.searchHl`, ...) and the `window.__pt` hooks stable; tests
depend on them.

## Session file format (`.ptl`)

Line-oriented plain text, one logical fact per line, free text always
last on the line (no escaping; newlines are flattened on save). Designed
so appending an entry is a one-line git diff. Internal ids never appear;
stacks are an ordered list and `active` is a 0-based position.

```
paper-trail-session v1
saved 2026-07-10T12:34:56.000Z
pdf.name WStarCats.pdf
pdf.relPath WStarCats.pdf
pdf.fingerprint dcc47481…
pdf.size 547247
view.scale 1.27
view.fitWidth true
view.page 17
view.yRatio 0.42
active 0

stack RoundTrip
cursor 1
entry 8 0.2998 Start
entry 17 0.42 Lemma test-marker
```

Positions are scale-independent `{page, yRatio}`. The app never resolves
filesystem paths between the session and its PDF (browser sandboxes
don't expose paths) — the user supplies both files; `pdf.relPath` is
only used by the `?file=` dev mode, where URL-relative resolution works.

## pdf.js v6 embedding gotchas (hard-won)

- The text layer is sized by CSS rules over per-span custom properties
  (`--font-height`, `--scale-x`) against `--total-scale-factor`; see
  `globals.css`. Without them, spans lay out at the inherited font size
  and selection/search/label geometry silently breaks.
- Canvas geometry must be device-pixel exact: backing store =
  `round(css × dpr)`, CSS box = `backing / dpr`, render transform =
  exact backing/viewport ratio. Anything else resamples and softens
  every glyph. Don't cap `devicePixelRatio` (browser zoom raises it);
  cap only total canvas area.
- `getDocument({data})` **transfers** the buffer — read `byteLength`
  before. Destroy via the loading task. `convertToViewportRectangle` is
  gone; convert the two corners with `convertToViewportPoint`.
- The annotation layer must be `pointer-events: none` with links opting
  back in, or it eats text selection.
- A scale change mid-render invalidates the in-flight render; something
  must re-trigger rendering (see `ensureRendered`'s finally block) or
  pages stay blank.
- Smooth zoom = CSS transform during the gesture (anchor held fixed),
  re-render on commit, stale canvases kept stretched as placeholders.
  Inter-page gaps scale with `--scale-factor` so transform and layout
  agree — constant gaps caused an ~800px jump at pinch release.

## Undo design and performance

Undo of history mutations is deliberately naive: every structural
mutation pushes a full deep copy (`serialize()`) onto a bounded stack
(50 deep, oldest dropped; in-memory only; redo cleared by any new
action). `npm run perf` proves this is the right call: a snapshot costs
0.01 ms at realistic scale, 0.6 ms at an absurd 100k entries, and never
shows up in the CPU profile — rendering the unvirtualized history list
dominates long before the data structure matters.

Measured limits (documented, not enforced): localStorage auto-resume
hard-fails beyond ~63k total entries (quota; session files unaffected);
interactions soften past ~20k entries in the active trail.

PDF replacement has its own single-slot document-level undo: the
previous document is retained as a cheap re-readable source (File /
handle / URL — never copied bytes) and any history mutation supersedes
the pending replace-undo (`NavStacks.onMutate`).

## Conventions

- One commit per feature/fix, after its tests pass; descriptive messages
  focused on the why.
- UI copy: plain language, no data-structure jargon.
- Panels own their widths independently — resizing/closing one never
  resizes another.
- History entry anchors change only through explicit user actions.
