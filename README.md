# PDF Stack Reader

A PDF reader built around navigation history you can trust: a **list of
history stacks** with browser-style back/forward, plus forking.

When reading a math paper you often descend several levels deep — Lemma 3.16 →
Definition 2.4 → Equation (7.2) — and then need to find your way back to where
you were actually reading. PDF Stack Reader records every jump you make
(internal link, outline entry, page jump, search hit):

- each jump is **pushed onto the active stack**; `Backspace` pops back up,
  returning to the *exact* scroll position you left, not just the page;
- `Shift+Backspace` goes forward again; the stack is preserved until you
  follow a new link mid-stack, which overwrites the entries above the cursor
  (exactly like browser history);
- **Cmd/Ctrl+click** (or middle-click) a link to **fork**: the whole history
  up to the cursor is copied into a new stack — so unlike a browser tab
  opened with cmd+click, back still works there — and the new stack is saved
  in the sidebar's stack list (renamable, closable, switchable);
- click any entry in the History panel to move the cursor there;
- hover an internal link for ~⅓s to get a page-width popup preview of its
  destination, aligned with the PDF; move the cursor into it to scroll it,
  and drag its bottom edge to resize.

Entries are labelled from the text around the link ("Lemma 3.16", "(7.2)", ...)
plus the destination page. History, zoom, and position are restored per
document when you reopen it.

## Reading-progress files

Your full reading state (all stacks, cursor, zoom, exact position) can be
saved to a file at a location and name you choose (`Save` button or
`Cmd/Ctrl+S`; suggested name `<pdf>.psr`). The format is a line-oriented
plain-text format (one history entry per line) designed to produce small,
semantically clear git diffs. The file stores a relative reference to the
PDF, so keeping the pair side by side makes it portable.

- **Open a plain PDF**: the app warns about unsaved reading progress when
  you close it. Once you save to a file, the session is bound to it.
- **Open a progress file** (Open button, drag & drop, or
  `?file=path/to/x.psr`): the PDF is located automatically (a previously
  granted file handle, the relative path when served over HTTP, or one
  picker prompt), the state is restored, and from then on progress
  **auto-saves continuously** to that file — so closing never warns unless
  a save is still pending or failed.

Saving/auto-saving to files uses the File System Access API (Chromium-based
browsers and the desktop app); everything else works anywhere.

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

## Notes / limitations

- Search matches cannot span line breaks (page text is the raw extraction
  order of the PDF's text items).
- PDFs needing CJK cMaps or non-embedded standard fonts are not wired up
  (easy to add: pdf.js `cMapUrl` / `standardFontDataUrl` options).
- Per-document state is keyed by PDF fingerprint in `localStorage`; recent
  files (with re-openable handles) live in IndexedDB.
