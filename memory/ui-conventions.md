---
name: ui-conventions
description: "UI rules — inline SVG icons, fixed-height rows/no jank, shortcut gotchas, open-routing, error-message precision"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

- Icons: ALWAYS inline SVG (src/ui/icons.tsx), never unicode glyphs
  (owner rule). Root font 13px → 1rem=13px, all Tailwind spacing
  scales by 0.8125.
- Rows: fixed-height; rename input reproduces the span box exactly (no
  layout shift) — owner is very sensitive to UI jank/misalignment.
  NEVER claim alignment from eyeballing screenshots: measure pixel
  centroids numerically (in CI: png→raw + python) with tolerance.
- Menu shows real single-key accelerators (M/Shift+M/T); renderer
  re-inserts the char when a text field has focus. All shortcuts
  modifier-based (not vim-style). Gotchas: mod+E and mod+Shift+E are
  browser-owned (never reach the page); re-anchor = mod+G; mod+F
  toggles the find bar.
- Open-routing: PDF picked/OS-opened while a doc is open → NEW window
  (desktop, pt-open-new-window IPC) / NEW tab (web, window.open +
  postMessage File handoff, initTabHandoff); empty windows reused; pdf
  drag-drop no-op when doc open (session drops OK). Recents =
  pdf+session pair, all-or-nothing with file-specific error.
- Error dialogs/toasts must name the exact failing thing, never
  either/or ambiguity.
- No "branch" noun in user copy — only multiple trails / duplicating.
- NEVER launch always-on-top/focus-stealing windows on the owner's
  machine (explicit complaint).
- See [[desktop-shell]], product-design.md.
