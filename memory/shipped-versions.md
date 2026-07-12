---
name: shipped-versions
description: "Release history v0.3.4 → v0.5.11 — what each version shipped, skipped versions, verification results"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Latest released: **v0.5.11**. All releases verified post-publish:
dash-named assets, updater URLs 200, deploy-web green.

- v0.5.11 PUBLISHED+verified (10 assets): HiDPI-crisp NSIS installer
  (customHeader ManifestDPIAware), taskbar Jump List New Window
  (setAppUserModelId on win32), dark blended scrollbars (superseded by
  native scrollbars on main), ONE panel layout system (22px rows,
  hover tools overlay, x on hover/active only, single right-edge axis,
  lists start on one line — asserted in trailRowLayout), flash-free
  document opens (openPath reuses ANY empty window; showWhenLoaded
  reveals on title change, 4s fallback), Tab cycling removed + click
  blur, preview bottom-edge clamp.
- v0.5.10 SKIPPED (gate flake blocked its release).
- v0.5.9: NSIS graceful-close (installer.nsh customCheckAppRunning —
  asks, never taskkill /F, exit 4 on refusal), SILENT background
  updates (install on quit; next start toasts "was updated to X" via
  userData last-version.txt marker + 'updated' pt-menu action),
  restart asks edited windows first (editedWindows via
  pt-document-edited), mid-download re-check resumes progress view.
- v0.5.8 PUBLISHED+verified: Software Update window (update.html +
  src/update/main.tsx, pt-update-* ids — being replaced by native
  prompts), restart guards unsaved sessions, save-from-close data-loss
  fix (picker never settles after canceled unload — close-prompt saves
  route to shell dialog via 'save-from-close'), Windows Jump List New
  Window.
- v0.5.7: update-404 fix (space-free artifactNames + updateFeedNames
  test), release-gated Vercel deploy (deploy.yml DELETED), ci.yml
  cancel-in-progress concurrency (later removed by owner).
- v0.5.6 SKIPPED; v0.5.5 repaired in place with 6 alias assets.
- v0.3.4: first signed+notarized mac build (spctl "Notarized Developer
  ID" verified).

Since 0.5.11 on main (unreleased, queued for v0.5.12): derived-title
no-flash fix, native doc icons (mac: afterPackMac strips
CFBundleTypeIconFile → LaunchServices composes; win: page+logo+label),
plated app icon everywhere (win/web too), NSIS stock installer icons,
native scrollbars (custom CSS deleted), core-gap tests + parseProgress
hardening, c8+Codecov (OIDC, 96.18%, informational), CI on every
branch push, review workflows (mac-screenshot, windows-file-icons,
mac-scrollbar, mac-update-ui), preview survives annotation-layer
rebuilds (merge ec848e2). See [[release-engineering]].
