# Changelog

User-facing changes per release. The release workflow copies the
matching section into the GitHub Release notes.

## 0.5.0

- The desktop apps now **update themselves**: new releases download in
  the background and install when you quit (a toast tells you when one
  is ready; macOS also has Check for Updates… in the app menu). Windows
  updates download only the changed pieces. This release is the last
  one you need to install by hand.
- Session files from a newer version of Paper Trail are refused with a
  clear "update the app" message instead of failing confusingly.

## 0.4.7

- Fixed: Load Reading Session (and first-time Save) from the macOS menu
  bar did nothing — menu clicks can't open the browser-style file
  pickers, so the app's own dialogs handle both now.
- The Recent list remembers each PDF together with its saved session
  and reopens them as a pair. If either file has gone missing, nothing
  loads at all and the message names exactly which file it was; a PDF
  that never had a session still reopens on its own.
- Opening a PDF while one is already showing opens it in a new window
  (desktop) or a new tab (web) instead of replacing what you're
  reading; an empty window is used directly.
- `Cmd/Ctrl+F` now toggles the search bar — pressing it again closes
  the bar and clears the highlights.
- Windows: the app now ships for ARM (one installer covers both Intel
  and ARM; separate zips per architecture).

## 0.4.6

- Windows: the toolbar now uses the standard 48px height that Fluent
  recommends for title bars with content (like Outlook and Edge), so
  it no longer feels cramped.

## 0.4.5

- Fixed: marking a spot (`Cmd/Ctrl+D`) no longer silently rewrites the
  anchor of the entry you were on — anchors only ever move when you
  re-anchor deliberately.
- Fixed: expanding an outline section after Collapse All no longer
  flashes the whole subtree before settling.
- Re-anchoring is now `Cmd/Ctrl+G` (the E-based combos belong to the
  browser and never reached the app).
- The app feels more at home on the desktop: the macOS close button
  shows the standard dot while the session has unsaved changes, opened
  files appear in the title-bar proxy and the Windows taskbar Jump
  List, the Dock menu offers New Window, and there's a proper About
  panel.

## 0.4.4

- Search is a floating find bar now: `Cmd/Ctrl+F` summons it, Escape
  puts it away, and the toolbar never shifts. The undo/redo buttons are
  gone too (`Cmd/Ctrl+Z` does that), leaving a leaner toolbar.
- History entries show a hover × to remove just that entry (undoable),
  and the page-number badge is gone.
- The outline has Expand All / Collapse All buttons.
- New shortcuts: `Alt+Shift+D` duplicates the current trail, and
  re-anchoring is `Cmd/Ctrl+Shift+E` (plain `Cmd/Ctrl+E` belongs to the
  browser and never worked there).
- Windows: the window buttons sit at the platform's standard caption
  size and can no longer cover toolbar content.
- Right-clicking dead space no longer shows a stray menu, and the
  empty-state drop overlay mentions session files.

## 0.4.3

- Opening a PDF and loading a session are now fully separate actions:
  `Cmd/Ctrl+O` (and File ▸ Open) picks PDFs only, `Cmd/Ctrl+Shift+O`
  (and Load session…) picks session files only, and the toolbar Open
  button is gone — opening lives on the welcome screen, the shortcut,
  and drag-and-drop.
- With a document open, dropping a PDF no longer replaces it (open
  another window for another paper); dropping a session file still
  loads it.
- Desktop: files opened from the OS (Open With…, dropping onto the app
  icon) always get their own window, and the cheat-sheet includes
  desktop shortcuts such as `Cmd/Ctrl+N`.
- The hover preview can be resized from its top edge too, and it never
  covers the link you're hovering, even in small windows.

## 0.4.2

- Every keyboard shortcut now uses a modifier, like a normal app —
  plain typing never triggers anything. Back/Forward are `Alt+←`/`Alt+→`
  (or `Cmd/Ctrl+[`/`]`), mark is `Cmd/Ctrl+D`, re-anchor is
  `Cmd/Ctrl+E`, trails switch with `Alt+[`/`Alt+]`, the sidebar toggles
  with `Cmd/Ctrl+B`.
- Press `?` for a proper shortcut cheat-sheet overlay.
- Right-click menus everywhere, and they feel native: full edit menus
  with spell-check in text fields, Copy / Look Up / "Search Document
  for …" on selections, and context actions on links (follow, follow in
  a new trail), history entries (jump, rename, re-anchor), trails
  (switch, rename, duplicate, close), and the page (back, forward,
  mark, zoom).
- Windows: the window buttons are integrated into the toolbar and the
  menu bar is gone — everything is in the app itself.
- macOS: the traffic lights are now exactly centered in the toolbar.
- The README explains what trails and branches are up front.

## 0.4.1

- Session files are now fully transparent: they identify the PDF by
  **name only** — no more hidden fingerprint. Opening a session is
  always two explicit steps (session file, then PDF); the app never
  opens a PDF by itself. Old session files still load.
- Re-anchoring an entry (⌖) now also refreshes its label to the new
  position — unless you renamed the entry yourself, in which case your
  name is kept. New `r` shortcut re-anchors the current entry.
- macOS: the traffic lights sit properly centered in a native-height
  toolbar.
- Trails: a + button starts a fresh trail, every trail can be
  duplicated from its row, and `[` / `]` switch between trails.
- Press `?` for the shortcut cheat-sheet.
- The Recent list on the welcome screen has a × to remove entries.
- Desktop: standard right-click menus, a leaner toolbar (Open and the
  GitHub link live in the menus / web version), and properly centered
  traffic lights on macOS.
- Paper Trail is now MIT licensed.

## 0.4.0

- Desktop apps grew standard behaviors: multiple windows (Cmd/Ctrl+N),
  Open… in a new window, Open With… / dragging a PDF onto the Dock
  icon, Open Recent, remembered window size, a standard
  Save / Don't Save / Cancel close prompt, and .pdf/.ptl file
  associations.
- The outline is collapsible: sections with subsections get a chevron.
- The hover preview is sharp and scrolls through the entire document.
- All icons are crisp SVGs; keyboard hints show your platform's own
  modifier key; single-key shortcuts (m, Shift+M, t) appear in the
  macOS menus; renaming happens in place without the row shifting.
- Opening a PDF always starts fresh — reading state lives only in
  session files you save explicitly.

## 0.3.4

- macOS builds are signed and notarized — no more right-click → Open.

## 0.3.1

- First public release: reading trails with exact-position
  back/forward, branching (Cmd/Ctrl+click), hover previews, search,
  plain-text session files, and web + macOS + Windows builds.
