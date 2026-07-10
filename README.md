# PDF Tree Reader

A PDF reader built around one idea: **navigation history is a tree, not a stack**.

When reading a math paper you often descend several levels deep — Lemma 3.16 →
Definition 2.4 → Equation (7.2) — and then need to find your way back to where
you were actually reading. PDF Tree Reader records every jump you make
(internal link, outline entry, page jump, search hit) as a node in a tree shown
in the sidebar. You can:

- pop back up level by level (`Backspace`), returning to the *exact* scroll
  position you left, not just the page;
- descend again (`Shift+Backspace`) along the branch you last took;
- branch: going back and following a *different* link creates a sibling branch,
  so no exploration is ever lost;
- click any node in the History panel to teleport there.

Nodes are labelled from the text around the link ("Lemma 3.16", "(7.2)", ...)
plus the destination page.

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
./desktop/make-app.sh   # creates dist/PDF Tree Reader.app
```

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Backspace` / `Alt+←` | Back (up the history tree) |
| `Shift+Backspace` / `Alt+→` | Forward (down the last branch) |
| `/` or `Cmd/Ctrl+F` | Focus search |
| `Enter` / `Shift+Enter` | Next / previous match |
| `+` / `-` / `0` | Zoom in / out / fit width |
| `t` | Toggle sidebar |
| `o` | Open file |

## Project layout

```
index.html, style.css   UI shell
js/viewer.js            pdf.js rendering: lazy pages, text layer, links, zoom
js/navtree.js           the navigation tree (data structure + panel rendering)
js/search.js            full-text search with precise highlight overlays
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
- History is stored per document fingerprint in `localStorage`.
