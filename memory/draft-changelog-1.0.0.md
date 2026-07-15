## 1.0.0

Paper Trail 1.0. From this release on, session files are stable: every
future version of Paper Trail opens sessions saved by this one.

- Search now runs off the main thread and shows matches while it is
  still indexing — typing in the find bar stays instant even on large
  papers, and the match count fills in live.
- Saving at the close prompt is reliable: choosing Save… always shows
  the location picker and writes the full session before the window
  closes. (Previously the app could quit first, losing the session —
  on Windows it could even leave a zero-byte file.)
- Your saved reading position can no longer be corrupted by a failed
  PDF replacement or by an auto-save racing a document that is still
  opening.
- Dropping a PDF and a session file together now always binds the
  session file as the save target, whatever order they arrive in.
  (Previously a save could overwrite the PDF itself.)
- Edits made while a save is already writing are no longer lost.
- The Recent list merges correctly across windows — opening files in
  one window no longer erases another window's entries.
- Opening two files quickly gives each its own window; a file opened
  from a terminal with a relative path resolves correctly; opening a
  file into an existing window brings it to the front; and a window
  remembered on an unplugged monitor comes back on screen.
- Renaming is watertight: the rename box always gets the full row,
  hover tools keep their spacing without covering anything clickable,
  a rename can never land on a different entry, and Alt+Arrow keys
  stay in the text box you are typing in.
- A consistent visual pass: panel headers, list rows, the outline
  tree, the Recent list, and the find bar all share the same edges and
  type sizes.
- Zooming with a pinch no longer carries the gesture onto a newly
  opened document, very large pages render correctly at high zoom, and
  thumbnails refresh when a PDF is replaced by a same-named file.
- Windows: the Installed-apps list shows the real app icon, and the
  installer offers checkboxes for the desktop and Start Menu shortcuts
  (both on by default).
- The README demo video is freshly recorded from this version.
