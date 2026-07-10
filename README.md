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
  in the sidebar's stack list. Switch between stacks freely; close them when
  done;
- click any entry in the History panel to move the cursor there;
- hover any internal link for ~⅓s to get a popup preview of its destination
  without jumping at all.

Entries are labelled from the text around the link ("Lemma 3.16", "(7.2)", ...)
plus the destination page. History, zoom, and position are restored per
document when you reopen it.

## Reading-progress files

Your full reading state (all stacks, cursor, zoom, exact position) can be
saved to a JSON file at a location and name you choose (`Save` button or
`Cmd/Ctrl+S`; suggested name `<pdf>.psr.json`). The file stores a relative
reference to the PDF, so keeping the pair side by side makes it portable.

- **Open a plain PDF**: the tab warns about unsaved reading progress when
  you close it. Once you save to a file, the session is bound to it.
- **Open a progress file** (Open button, drag & drop, or
  `?file=path/to/x.psr.json`): the PDF is located automatically (a
  previously granted file handle, the relative path when served over HTTP,
  or one picker prompt), the state is restored, and from then on progress
  **auto-saves continuously** to that file — so closing the tab never warns
  unless a save is still pending or failed.

Saving/auto-saving to files uses the File System Access API and needs a
Chromium-based browser; everything else works anywhere.

## Running as a web app

Requires Node (any recent version). No dependencies, no build step
(pdf.js is vendored in `vendor/`).

```sh
node server.js          # http://127.0.0.1:8377
node server.js 9000     # custom port
```

Open the URL in a browser, then open a PDF with the Open button, drag & drop,
or `?file=<path under this folder>`.

## Running as a desktop app

The full desktop shell (Electron) has native menus — File (Open, Save
Progress), Edit, View (zoom, sidebar, fullscreen), History (Back/Forward),
Window — and turns the unsaved-progress warning into a native dialog:

```sh
npm install        # once, pulls electron as a dev dependency
npm run desktop
```

The shell just serves the unchanged web app on an ephemeral localhost port;
menu items dispatch to the same in-app functions, and the web app keeps
working in any normal browser.

There is also a dependency-free lightweight wrapper (Chromium `--app` mode,
no menus):

```sh
./desktop/launch.sh
./desktop/make-app.sh   # creates dist/PDF Stack Reader.app (double-clickable)
```

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
index.html, style.css   UI shell
js/viewer.js            pdf.js rendering: lazy pages, text layer, links, zoom
js/history.js           list of history stacks (data structure + panel UI)
js/search.js            full-text search with precise highlight overlays
js/store.js             localStorage state + IndexedDB recents/file handles
js/preview.js           hover preview popup of link destinations
js/main.js              wiring, outline, keyboard, open/drop/persistence
server.js               dependency-free static server (binds 127.0.0.1 only)
test/e2e.mjs            headless end-to-end tests (npm test, needs server up)
desktop/                desktop-app wrapper scripts
vendor/                 pinned pdf.js (pdfjs-dist 5.4.149)
```

## Notes / limitations

- Search matches cannot span line breaks (page text is the raw extraction
  order of the PDF's text items).
- PDFs needing CJK cMaps or non-embedded standard fonts are not wired up
  (easy to add: pdf.js `cMapUrl` / `standardFontDataUrl` options).
- Per-document state is keyed by PDF fingerprint in `localStorage`; recent
  files (with re-openable handles) live in IndexedDB.
