# Paper Trail

A PDF reader built around navigation history you can trust: parallel
**reading trails** with browser-style back/forward, plus branching.
(Internally each trail is a history stack; the package/repo keeps the
technical name `pdf-stack-reader`.)

When reading a math paper you often descend several levels deep — Lemma 3.16 →
Definition 2.4 → Equation (7.2) — and then need to find your way back to where
you were actually reading. Paper Trail records every jump you make
(internal link, outline entry, page/thumbnail jump, search hit):

- each jump is **pushed onto the active trail**; `Backspace` pops back up,
  returning to the *exact* scroll position you left, not just the page;
- `Shift+Backspace` goes forward again; the stack is preserved until you
  follow a new link mid-trail, which overwrites the entries above the cursor
  (exactly like browser history);
- **Cmd/Ctrl+click** (or middle-click) a link to **fork**: the whole history
  up to the cursor is copied into a new trail — so unlike a browser tab
  opened with cmd+click, back still works there — and the new trail is saved
  in the sidebar's trail list (renamable, closable, switchable);
- click any entry in the History panel to move the cursor there;
- **undo/redo** (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`) reverts history
  *mutations*: an overwritten forward tail, a fork, a closed or renamed
  stack, a cleared history. Deliberately fragile like ordinary undo:
  in-memory only (gone after reopening), and any new action clears redo;
- hover an internal link for ~⅓s to get a page-width popup preview of its
  destination, aligned with the PDF; move the cursor into it to scroll it,
  and drag its bottom edge to resize.

Entries are labelled from the text around the link ("Lemma 3.16", "(7.2)", ...)
plus the destination page. History, zoom, and position are restored per
document when you reopen it.

## Reading sessions

Your full reading state (all trails, cursor, zoom, exact position) can be
saved to a **reading-session file** at a location and name you choose
(**Save session** / `Cmd/Ctrl+S`; suggested name `<pdf>.psr`). The format
is line-oriented plain text (one history entry per line, an ordered list
of trails, no internal ids) designed for small, semantically clear git
diffs; names and labels with any characters are safe.

The app never guesses filesystem paths (browser sandboxes don't expose
them): you supply the PDF and the session file explicitly, in either
order, and the UI makes both directions seamless:

- **PDF first**: it opens normally; **Load session…** (also
  `Cmd/Ctrl+Shift+O` in the desktop app) loads a session into it, with a
  confirmation when it would replace non-trivial reading history.
- **Session first**: the viewer shows a prompt naming the PDF the session
  belongs to — open or drop it and you're back where you left off. (A
  previously used PDF is re-opened silently when possible.)
- Once bound to a file, the session **auto-saves continuously**; closing
  only warns when something isn't saved yet. Unbound reading warns on
  close until you save.
- **Wrong PDF?** The session remembers the PDF's name; a mismatch shows a
  dismissable banner with **Use this PDF**, which adopts the open file
  into the session. Saved positions that don't exist in the current PDF
  simply land at the top.
- **Replace PDF** (⇄ next to the title): swap in another file — say, a
  revised version of the paper — keeping the whole reading history.
- Entry anchors never move as you scroll; re-anchor one deliberately with
  the ⌖ button on its row (hover), rename entries/trails by double-click.

Saving/auto-saving to files uses the File System Access API (Chromium-based
browsers and the desktop app); everything else works anywhere. Dev/test
convenience: `?file=path/to/x.psr` over the local server resolves the PDF
URL-relatively.

## Stack

TypeScript throughout. React + Vite + Tailwind CSS for the UI; the pdf.js
(`pdfjs-dist`) rendering core is an imperative, typed module behind a thin
controller the UI subscribes to. Electron for the desktop shell. Python for
the helper scripts. No hand-written vendored code.

## Develop / run as a web app

```sh
npm install
npm run dev          # Vite dev server (hot reload)

npm run build        # typecheck + build web app and node/desktop/test code
npm start            # serve the built app at http://127.0.0.1:8377
python3 desktop/launch.py   # build-if-needed + serve + open browser
```

Open a PDF with the Open button, drag & drop, or `?file=sample/....pdf`.

## Desktop app

```sh
npm run build
npm run desktop              # Electron shell
python3 desktop/make_app.py  # dist/PDF Stack Reader.app (double-clickable)
```

The shell serves the built web app over a custom `psr://` protocol and adds
native menus — File (Open `Cmd+O`, Save Progress `Cmd+S`), Edit, View (zoom,
fit, sidebar, fullscreen), History (Back `Cmd+[`, Forward `Cmd+]`), Window —
and shows the unsaved-progress warning as a native dialog. The web app
itself is unchanged and keeps working in any normal browser.

## Tests

```sh
npm run build && npm start   # in one terminal
npm test                     # in another
```

Headless end-to-end suite (playwright-core driving a separate headless
Edge/Chrome with its own profile — it never touches your browsing session):
rendering, labelled link jumps, exact-position back/forward, forking, panel
resizing at the extremes, hover preview geometry, search highlights, and
progress-file save/restore round trips.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Backspace` / `Alt+←` | Back (pop up the active stack) |
| `Shift+Backspace` / `Alt+→` | Forward (down again) |
| `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` | Undo / redo history changes |
| `Cmd/Ctrl+click` or middle-click on a link | Fork history into a new stack |
| `/` or `Cmd/Ctrl+F` | Focus search |
| `Enter` / `Shift+Enter` | Next / previous match |
| `+` / `-` / `0` | Zoom in / out / fit width |
| `Cmd/Ctrl+S` | Save reading progress (save-as when unbound) |
| `t` | Toggle sidebar |
| `o` | Open file |

## Project layout

```
index.html, vite.config.ts   Vite entry
src/core/                    typed app core: viewer (pdf.js), history stacks,
                             search, hover preview, persistence, controller
src/ui/                      React components (Tailwind)
src/node/server.ts           static server for browser use (127.0.0.1 only)
src/desktop/                 Electron shell (custom psr:// protocol, menus)
src/test/e2e.ts              headless end-to-end suite
desktop/launch.py            build-if-needed + serve + open browser
desktop/make_app.py          generate the macOS .app bundle
```

## Performance (undo/redo snapshots)

Undo is implemented the simplest possible way: every structural mutation
deep-copies the entire state (all stacks) onto a bounded (50) undo stack.
`npm run perf` measures whether that holds up (headless, real app,
DevTools-protocol CPU profile + GC-fenced heap):

| scenario | entries | state | snapshot | visit | undo | undo-stack heap |
| --- | --- | --- | --- | --- | --- | --- |
| realistic (5×50) | 250 | 22 KB | 0.01 ms | 1 frame | 1 frame | 0.4 MB |
| heavy reader (20×200) | 4 000 | 355 KB | 0.03 ms | 1 frame | 1 frame | 3.8 MB |
| many stacks (200×50) | 10 000 | 0.9 MB | 0.14 ms | 1 frame | 1 frame | 9 MB |
| deep stacks (10×2000) | 20 000 | 1.8 MB | 0.23 ms | ~1.5 frames | 1 frame | 20 MB |
| absurd (20×5000) | 100 000 | 9 MB | 0.57 ms | ~3 frames | ~2 frames | 91 MB |

("1 frame" = completes within a single 60 Hz frame.) The CPU profile of the
worst case shows the time goes to DOM/React rendering of the huge history
list and `scrollIntoView` — the snapshot copy itself never exceeds 0.6 ms
and does not appear among the top functions. Conclusion: the naive
full-copy undo is the right data structure; no cleverness warranted at any
plausible reading workload.

**Empirical limits** (measured by the same profiler; none are enforced):

- **Hard**: auto-resume via localStorage stops working beyond **~63 000
  total history entries** (browser quota; the app degrades gracefully by
  skipping it). Session *files* have no such limit.
- **Soft**: interactions exceed ~100 ms (start feeling sluggish) around
  **~20 000 entries in the active trail** (2 000 → 21 ms, 10 000 → 61 ms,
  20 000 → 140 ms, 80 000 → 618 ms); the cost is rendering the
  unvirtualized history list, not the data structures.
- **Undo**: depth is capped at **50 snapshots**; exceeding it silently
  drops the oldest (verified by test). Undo history is in-memory only —
  gone after reopening — and any new action clears redo.

## Notes / limitations

- Search matches cannot span line breaks (page text is the raw extraction
  order of the PDF's text items).
- PDFs needing CJK cMaps or non-embedded standard fonts are not wired up
  (easy to add: pdf.js `cMapUrl` / `standardFontDataUrl` options).
- Per-document state is keyed by PDF fingerprint in `localStorage`; recent
  files (with re-openable handles) live in IndexedDB.
