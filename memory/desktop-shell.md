---
name: desktop-shell
description: "Electron shell facts — windows/IPC/menus, platform quirks (macOS Tahoe, win32 menus, koffi), update-flow seams"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

- src/desktop/main.ts: multi-window; OS file opens via pt-open-file IPC
  (+ per-window ready queues); hiddenInset traffic lights
  (body.desktopMac drag region); Save/Don't Save/Cancel close prompt;
  file associations; smoke test accepts a file arg for the OS-open
  path; PT_DEBUG=1 traces. PT_SHOT=1 shows a dev window WITHOUT
  stealing focus; PT_USERDATA isolates profile + single-instance lock
  from an installed copy.
- Native Win32 menus (src/desktop/winMenu.ts, koffi): validated
  visually via windows-screenshot.yml artifact; koffi EXCLUDED from
  mac bundles (universal-merge rejects per-arch prebuilds).
- Windows: no universal binary; NSIS packs x64+arm64 in one installer
  (win.target arch list). Fluent title bars with content = 48px.
- macOS Tahoe (26): Electron trafficLightPosition is IGNORED (measured
  identical for y:9 vs y:26); window-ID captures (screencapture -l)
  EXCLUDE the traffic lights (separate OS layer) — only full-screen
  captures show them, gray when unfocused.
- Electron menu clicks have NO user activation → renderer file pickers
  throw SecurityError; menu Load/Save go through main-process dialogs.
- Update flow (v0.5.9-11 shape): silent background downloads, install
  on quit, next start announces via last-version.txt marker; menu
  'check-updates' opened the Software Update window (update.html,
  pt-update-* ids) — REBUILDING as native macOS prompts, owner order
  2026-07-12 (dialog.showMessageBox + Dock setProgressBar; custom CSS
  window rejected).
- Session files: .ptl ("paper-trail-session v1" header). Legacy psr
  identifiers all purged: protocol paper-trail://, hooks window.__pt,
  ptDesktop bridge, pt: storage prefixes.
- pdf.js cMaps + standard_fonts bundled to dist-web/pdfjs (CJK/
  offline); viewer passes cMapUrl/standardFontDataUrl via
  document.baseURI. vite-plugin-static-copy v4 preserves source paths
  by default: flatten with rename: { stripBase: true } per target.
- The desktop app binds no TCP ports (paper-trail:// protocol); node
  server is browser-only. See CLAUDE.md design rules.
- See [[ui-conventions]], [[ci-testing]].
