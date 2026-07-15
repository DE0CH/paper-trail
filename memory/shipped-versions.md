---
name: shipped-versions
description: "Release history v0.3.4 → v0.5.13 — what each version shipped, skipped versions, verification results"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Latest released: **v0.5.13**. All releases verified post-publish:
dash-named assets, updater URLs 200, deploy-web green.

- v0.5.13 PUBLISHED+verified (10 assets): Sparkle-style native
  "Software Update" WINDOW (offer "A new version…available" → Update
  Now → progress bar → "Ready to update" → Restart to Update) with an
  interruptable Cancel that stops the download mid-flight; native doc
  icons; plated app icon everywhere; NSIS stock installer icons; native
  scrollbars; no-flash windows; hover preview; .ptl-then-PDF
  save-binding fix (opening a session then its PDF keeps auto-save
  bound, no Save-As prompt); mac+win update-resilience tests (SIGKILL /
  taskkill /F, mid-install kill, corrupt download — electron-updater's
  atomic staging proved resilient, no product bug found). update-flash-
  close CUT (see docs/flash-close-finding.md — held fix skips the
  update; deferred, needs owner decision).
- v0.5.12 SKIPPED: release.yml startup-failed. Cause: the reusable
  ci.yml requests `id-token: write` (Codecov OIDC, added after 0.5.11)
  but release.yml (the CALLER) only granted `contents: write` — a
  called workflow can't exceed its caller's permissions → GitHub
  refuses to start it (startup_failure). Fixed by adding
  `id-token: write` to release.yml's permissions (v0.5.13). Also
  rewrote ci.yml's owner-keyed matrix from `fromJSON` to static-matrix
  + `runs-on` expression (workflow_call-safe). See [[release-engineering]].
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

On main since v0.5.13 (unreleased): recorder drip widened to ~24s
(2f3c56a) so the canceled update recording's Cancel lands mid-download.
Review/recording workflows on main: mac-screenshot, windows-file-icons,
mac-scrollbar, mac-update-ui (the "macOS update UI recording"
workflow_dispatch — records finished + canceled Sparkle-window videos
on macos-14, uploads artifact "sparkle-update-window"). c8+Codecov
(OIDC, informational) drives the id-token requirement above. See
[[release-engineering]].
