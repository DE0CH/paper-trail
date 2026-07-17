# Contributing and developer documentation

## Stack

The app is written in strict TypeScript throughout. The UI uses React,
Vite, and Tailwind CSS v4; rendering uses pdf.js (`pdfjs-dist` v6); the
desktop shell is Electron; helper scripts are written in Python. Nothing
is hand-vendored.

A note on naming: the code and the UI use different vocabularies for
the same concepts. What the UI calls a *trail* is a `stack` in the code
(see `NavStacks` in `history.ts`); the user-facing model is simply
multiple trails, and the action the UI describes as following a link
in a new trail is `fork` internally. What the UI calls a *reading
session* is a progress file in the code. Use the code vocabulary in
code and in this document, and the UI vocabulary in anything a user
reads.

## Architecture

```
index.html, vite.config.ts   Vite entry
src/core/                    framework-agnostic app core:
  viewer.ts                    imperative pdf.js viewer (lazy page windowing,
                               text/annotation layers, zoom, link labels)
  history.ts                   NavStacks: list of history stacks + snapshot undo
  search.ts                    search, DOM half: Range-based highlights,
                               current-match handoff
  searchWorker.ts              search, compute half in a Web Worker: page
                               text streams in, matches stream back
  preview.ts                   hover preview popup
  progressFormat.ts            .ptl serializer/parser
  boundFile.ts                 BoundFile: one identity per opened file
  recents.ts                   recently-opened list (PDF + session pairs)
  renderGeometry.ts            canvas backing-store math: size caps,
                               dpr-exact CSS boxes
  store.ts                     UI prefs (localStorage) and recents
                               persistence (IndexedDB)
  platform.ts, types.ts        modifier-key display names; shared types
  controller.ts                everything wired together; owns all state
src/ui/                      React components; subscribe to the controller
                             snapshot via useSyncExternalStore
src/node/server.ts           static server for browser use (127.0.0.1 only)
src/desktop/                 Electron shell: paper-trail:// protocol, native
                             menus (real Win32 popup menus), OS file opens,
                             window placement, shutdown guard, minimal
                             contextBridge
src/test/                    test suites (browser e2e, desktop shell
                             harnesses, installer tests, unit tests)
src/tools/                   generators and profiling: fixture PDFs,
                             icons, README media, perf (not tests)
desktop/launch.py            build-if-needed + serve + open browser
desktop/make_app.py          generate the macOS .app bundle
```

The core is imperative and owns all state. React renders an immutable
snapshot (`controller.getSnapshot()`) and calls controller methods. The
pdf.js canvases and text layers are non-React DOM inside a ref.

A file can reach the app two ways: as a browser `FileSystemFileHandle`
(pickers, Chromium drag-drop) or as an on-disk path string (OS opens,
the desktop shell's native dialogs). At acquisition it is wrapped in a
`BoundFile` (`boundFile.ts`), which is exactly one of the two and owns
all reading, writing, and permission checks from then on, so nothing
downstream branches on handle-versus-path.

Full-document search is split across threads: a dedicated Web Worker
(`searchWorker.ts`) receives each page's text as pdf.js extracts it and
streams matches back, so a query issued while the index is still
building shows results immediately and fills in as pages arrive; only
the DOM work (highlight drawing) stays on the main thread.

## Building, running, and testing

```sh
npm run dev        # Vite dev server (hot reload) on :5173
npm run build      # typecheck web (noEmit) + vite build → dist-web
                   # + tsc → build-node (server, electron, tests)
npm start          # serve dist-web at http://127.0.0.1:8377
npm run desktop    # Electron shell (loads dist-web over paper-trail://)

npm run test:unit  # fast unit tests for the pure core modules
npm test           # e2e suite — needs `npm start` running
npm run perf       # performance profile + limit search
```

CI additionally runs a battery of focused browser regression suites,
the desktop-shell harnesses (`test:desktop`, `test:offline`,
`test:autosave`, and friends), the auto-update tests (real
install–update–install cycles on Windows and macOS), and the installer
tests (`test:install:win` on x64 and ARM machines, `test:install:mac`
on Intel and Apple silicon), which install the packaged artifacts the
way a user would and smoke-test the result.

The unit tests (node:test, no extra dependencies) cover the pure core
modules — the navigation history, the session-file format, the
recently-opened list, file binding, and the canvas geometry — and run
in CI before the e2e suite.

The end-to-end suite drives a separate headless browser with
playwright-core — Playwright's version-pinned Chromium where it is
available, or an installed Edge or Chrome otherwise. It emulates a
person using the app — clicking PDF links, dragging dividers and text
selections, sending pinch (ctrl+wheel) bursts, and pressing keyboard
shortcuts — and asserts the outcomes, down to device-pixel-exact
canvas geometry and pinch-release position deltas. Please keep element
ids and classes (`#stacksPanel`, `.pdfLink`, `.searchHl`, and friends)
and the `window.__pt` hooks stable, because the tests depend on them.

When running the desktop shell next to an installed copy of the app,
set `PT_USERDATA` to any directory to get a separate profile and a
separate single-instance lock. Setting `PT_DEBUG=1` traces the IPC that
delivers OS file opens.

## Session file format (`.ptl`)

Session files are line-oriented plain text with one logical fact per
line, and free text always comes last on its line, so no escaping is
needed (newlines inside names are flattened on save). The format is
designed so that appending a history entry produces a one-line git
diff. Internal ids never appear in the file; stacks are an ordered
list, and `active` is a 0-based position into it.

```
paper-trail-session v2
pdf.name WStarCats.pdf
view.scale 1.27
view.fitWidth true
view.page 17
view.yRatio 0.42
active 0

stack RoundTrip
cursor 1
entry 8 0.2998 Start
named 17 0.42 my own label
```

Lines that start with `entry` carry automatic labels (link text,
`Marked p.N`, and so on), while `named` marks a label the user typed by
hand. Re-anchoring (⌖) refreshes automatic labels to the new position
but never touches hand-written ones.

Positions are scale-independent `{page, yRatio}` pairs. The file
identifies its PDF by name alone — deliberately no fingerprints,
hashes, or paths — so it contains nothing the user cannot see and
control. Opening a session is always two explicit steps (first the
session file, then the PDF), and a plain name comparison drives the
mismatch banner. Older files that still contain `pdf.relPath`,
`pdf.fingerprint`, or `pdf.size` lines parse fine; those keys are
ignored.

The `v<N>` header carries the compatibility promise: from 1.0 on the
format is strictly backward compatible, so every later version of the
app reads files written by every earlier one, migrating older formats
on load, while a file from a newer major version is refused with a
clear message rather than misread.

Version 2 removed v1's `saved <date>` line: a timestamp that changed on
every save put churn into otherwise clean git diffs, so the file
records no time at all. A file loaded as v1 keeps its version and its
recorded time when saved back — the `saved` line round-trips verbatim
(and a v1 file without one does not gain one), so saving never edits
the time.

## pdf.js v6 embedding notes

- The text layer is sized by CSS rules over per-span custom properties
  (`--font-height`, `--scale-x`) against `--total-scale-factor`; see
  `globals.css`. Without those rules, spans lay out at the inherited
  font size, and selection, search, and label geometry silently break.
- Canvas geometry must be device-pixel exact: the backing store is
  `round(css × dpr)`, the CSS box is `backing / dpr`, and the render
  transform is the exact backing-to-viewport ratio. Anything else
  resamples the bitmap and softens every glyph. Do not cap
  `devicePixelRatio` (browser zoom raises it); cap only the total
  canvas area.
- `getDocument({data})` transfers the buffer, so read `byteLength`
  before calling it. Destroy documents via the loading task. The
  `convertToViewportRectangle` helper is gone; convert the two corners
  with `convertToViewportPoint` instead.
- The annotation layer must be `pointer-events: none` with links opting
  back in, or it eats text selection.
- A scale change invalidates any in-flight render, and something must
  re-trigger rendering afterwards (see the `finally` block of
  `ensureRendered`), or pages stay blank.
- Smooth zoom works as a CSS transform during the gesture (with the
  anchor point held fixed) and a re-render on commit, keeping the stale
  canvases stretched as placeholders. Inter-page gaps must scale with
  `--scale-factor` so that the transform and the committed layout agree
  exactly; fixed-size gaps make the document jump when the gesture
  ends.
- Scrolling renders progressively: a page entering the window with no
  canvas first paints a quick pass at a third of the device resolution
  (stretched over the page box and marked `data-res="low"`), and the
  device-pixel-exact render replaces it atomically. While scrolling is
  active, only pages intersecting the viewport upgrade to the exact
  render; pages in the prefetch margins keep the cheap canvas until
  scrolling settles. Zoom-out reveals pages through the same two-pass
  path. Already-crisp pages are never touched by scrolling — they move
  purely by compositing.

## Undo design and performance

Undo of history mutations is deliberately naive: every structural
mutation pushes a full deep copy (`serialize()`) onto a bounded stack
that keeps 50 snapshots, drops the oldest, lives only in memory, and
clears its redo side on any new action. The profiler (`npm run perf`)
shows why this is the right call: a snapshot costs 0.01 ms at realistic
scale and 0.6 ms at an absurd 100k entries, and it never shows up in
the CPU profile — rendering the unvirtualized history list dominates
long before the data structure matters. One measured soft limit is
documented rather than enforced: interactions get sluggish past roughly
20k entries in the active trail.

PDF replacement has its own single-slot, document-level undo. The
previous document is retained as a cheap re-readable source (a File, a
handle, or a URL — never copied bytes), and any history mutation
supersedes the pending replace-undo (`NavStacks.onMutate`).

## Conventions

- Make one commit per feature or fix, after its tests pass, with a
  descriptive message focused on the why.
- Write UI copy in plain language without data-structure jargon.
- Panels own their widths independently: resizing or closing one never
  resizes another.
- History entry anchors change only through explicit user actions.

## Code signing

Every release binary is built and published by GitHub Actions from
this repository; nothing is built or signed on developer machines.
macOS builds are signed and notarized under an Apple Developer
account. For Windows builds, free code signing is provided by
[SignPath.io](https://signpath.io), with a certificate by the
[SignPath Foundation](https://signpath.org).

The team behind Paper Trail is also the team that owns this
repository and signs its builds. Deyao Chen
([@DE0CH](https://github.com/DE0CH)) is the author, reviewer of
external contributions, and approver of signing requests. External
contributions are only merged after review, and only artifacts built
from this repository's source are ever submitted for signing.

Privacy: Paper Trail does not collect or transmit user data. Reading
sessions stay in local files the user chooses. The only network
requests the desktop app makes are to GitHub Releases, to check for
and download updates; the web version additionally fetches its own
static assets from the hosting CDN. Beyond that, this program will
not transfer any information to other networked systems unless
specifically requested by the user.
