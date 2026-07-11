# Paper Trail

**A PDF reader that remembers how you got where you are.**

Reading a paper means chasing references: Lemma 3.16 sends you to
Definition 2.4, which sends you to Equation (7.2) — and five jumps later
you've lost the page you were actually reading. Paper Trail records every
jump on a **reading trail**, so you can always pop back to the exact spot
you left, branch off side explorations, and save the whole thing to a
file you can come back to (or keep in git next to the paper).

Following references, popping back, jumping around the history, and
branching into a new trail:

https://github.com/user-attachments/assets/dcff790c-ce33-457b-9f59-79731156e724

<p align="center">
  <img src="docs/media/main.png" width="49%" alt="Two trails in the sidebar after branching with cmd+click">
  <img src="docs/media/preview.png" width="49%" alt="Hovering a reference previews its destination at page width">
</p>

## Quick start

- **Use it in the browser**: https://paper-trail-green.vercel.app
  (a Chromium-based browser — Chrome, Edge, Brave — is needed for saving
  session files)
- **Or download the desktop app** (native menus, works offline):
  grab the `.dmg` (macOS) or installer (Windows) from the
  [**Releases page**](https://github.com/DE0CH/paper-trail/releases).
  The macOS build is signed and notarized; the Windows build is
  currently unsigned, so SmartScreen may warn the first time.

Then open a PDF with the **Open** button or drop it anywhere in the
window. (Building from source is covered in
[CONTRIBUTING.md](CONTRIBUTING.md).)

## Reading with trails

- **Follow any internal link** — it's pushed onto your trail, labelled
  from the text around it ("Lemma 3.16", "(7.2)").
- **Back** (`Alt+←`) pops back to the *exact* position you left;
  **Forward** (`Alt+→`) goes down again. Following a new link mid-trail
  overwrites the entries above you, exactly like browser history.
- **Cmd/Ctrl+click a link** (or middle-click) to **branch**: your whole
  history is copied into a new trail and the jump happens there — so Back
  still works, unlike a browser tab. Trails live in the sidebar: switch,
  rename (double-click), close.
- **Mark a spot** you reached by scrolling or searching with the `+`
  button above the history list (or `Cmd/Ctrl+D`) — recorded like a
  link jump.
- **Hover a link** for a moment to preview its destination in a panel the
  width of the page: scroll inside it, drag its bottom edge to resize.
- **Undo** (`Cmd/Ctrl+Z`) reverts history changes — an overwritten
  forward tail, a branch, a closed or renamed trail, even a replaced PDF.
- Entries never move on their own: scrolling doesn't touch them.
  Re-anchor one deliberately with the ⌖ button on its row (hover), or
  press `Cmd/Ctrl+E` for the current entry.

The leftmost panel shows the document **Outline** and **Pages**
(thumbnails); close it with ×, reopen it from the toolbar. All panels
resize by dragging their edges — each keeps its own width.

## Saving your place: reading sessions

**Save session** (`Cmd/Ctrl+S`) writes everything — all trails, position,
zoom — to a small plain-text file (`<pdf>.ptl`) wherever you choose. It
diffs cleanly, so versioning it in git alongside the paper works well.

- Open the PDF first and use **Load session…**, or open the session file
  first — the app shows which PDF it belongs to and asks for it. It's
  always these two explicit steps; the app never opens a file by itself.
- Once saved, the session **auto-saves continuously**; a dot on the Save
  button means unsaved changes, and closing warns if anything is unsaved.
- Got a revised version of the paper? **⇄ Replace PDF** swaps the file
  and keeps your whole reading history.

## Keyboard shortcuts

The ones worth learning first — press `?` (`Shift+/`) in the app for
the full cheat-sheet:

| Key | Action |
| --- | --- |
| `Alt+←` / `Alt+→` | Back / forward along the trail |
| `Cmd/Ctrl+click` a link | Branch into a new trail |
| `Cmd/Ctrl+D` | Mark the current position |
| `Cmd/Ctrl+S` | Save session |

## Notes

- Session files need the File System Access API: any Chromium-based
  browser, or the desktop app. Everything else works in modern browsers.
- Search matches can't span line breaks.

Developer documentation — architecture, tests, the session-file format,
performance analysis — lives in [CONTRIBUTING.md](CONTRIBUTING.md).
