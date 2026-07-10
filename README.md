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
- click any entry in the History panel to move the cursor there.

Entries are labelled from the text around the link ("Lemma 3.16", "(7.2)", ...)
plus the destination page. History, zoom, and position are restored per
document when you reopen it.

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

```sh
./desktop/launch.sh
```

starts the server and opens the app in a Chromium app window (Edge, Chrome,
Chromium, or Brave — whichever is installed) with no browser UI. The server
shuts down when the window closes. The web app remains a plain web app; the
wrapper is just presentation.

To get a double-clickable macOS app:

```sh
./desktop/make-app.sh   # creates dist/PDF Stack Reader.app
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
| `t` | Toggle sidebar |
| `o` | Open file |

## Project layout

```
index.html, style.css   UI shell
js/viewer.js            pdf.js rendering: lazy pages, text layer, links, zoom
js/history.js           list of history stacks (data structure + panel UI)
js/search.js            full-text search with precise highlight overlays
js/store.js             localStorage state + IndexedDB recents/file handles
js/main.js              wiring, outline, keyboard, open/drop/persistence
server.js               dependency-free static server (binds 127.0.0.1 only)
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
