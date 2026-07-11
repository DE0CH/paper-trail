# Changelog

User-facing changes per release. The release workflow copies the
matching section into the GitHub Release notes.

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
