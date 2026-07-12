---
name: ci-testing
description: "CI job shape, test-harness gotchas (updater feeds, playwright dialogs, runner quirks), coverage, fail-fast policy"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

- CI shape (owner-mandated): TWO jobs (windows, mac — steps genuinely
  differ) × runner matrix for arch: [windows-latest, windows-11-arm],
  [macos-latest, macos-15-intel]. Each: unit, browser e2e, desktopE2e
  (FULL e2e suite duplicated for Electron, offline via harness-side
  webRequest block), desktop harnesses, package, installer test,
  update test (win: real install→update→verify version+smoke; mac:
  download-only — Squirrel refuses unsigned installs — plus scripted
  manual menu flow). CI runs on every branch push; NO concurrency
  cancellation (owner removed it after rolling gate cancellations).
- CI must report ALL failures in a run, never fail fast, AND keep
  per-suite verdicts visible in the step list (owner rejected an
  aggregating shell loop): one step per suite, each
  `if: ${{ !cancelled() }}`; the web server starts in its own step
  (background processes outlive steps); only artifact-dependent chains
  (package→smoke→installer) stay gated.
- e2e runs against a GENERATED fixture pdf (src/test/fixture.ts;
  sample/ pdfs gitignored, .ptl fixtures committed). CJK regression
  fixture: sample/cjk.pdf (UniGB-UCS2-H, no embedded font).
- Tests/automation: headless playwright-core with installed
  Edge/Chrome, never the owner's browser. Exception: only when the
  owner explicitly asks to watch (claude-in-chrome on their tab).
- Coverage: c8 over src/core, Codecov via OIDC (96.18%), informational
  statuses only; README badge live.
- Update-test harness gotchas: latest*.yml urls are URL-safe (spaces→
  dashes) but on-disk artifacts keep spaces — feed server must map;
  never spawnSync while the harness hosts the feed (blocks accepts) or
  while a debugger-attached app must close (frozen node stalls the
  close); electron-updater's "Cannot download" message omits the port;
  dev runs need dev-app-update.yml next to the entry module; shared
  updater cache between tests must be wiped; playwright dialog
  listeners must answer beforeunload dialogs to MATCH intent
  (accept=leave); runner displays are 1024x768 (OS clamps windows).
- Desktop e2e-ish harnesses: patch electron dialog before
  require(main.js) (src/test/desktopSave.ts pattern).
- Windows-ARM installer bug (fixed): 7-Zip ≥22 packs arm64 binaries
  with the ARM64 branch filter; NSIS's Nsis7z can't decode → exes/dlls
  silently dropped. Fix: ELECTRON_BUILDER_7Z_FILTER=BCJ2 env on every
  electron-builder --win invocation (ci+release). NSIS = assisted
  wizard (oneClick:false) with Desktop+Start Menu shortcuts.
- Test battery (session 3): updateWindow(+Edges),
  updateRestartUnsaved(+Edges), updateMacWindowInstall,
  updateMacCancelThenQuit, updateWinQuitInstall, updateWinOpenAfter-
  Update, installerCloseUnsaved, newWindowTask, unitEdges, e2eEdges,
  desktopEdges. updateMacManualInstall retired (Test Deletion,
  owner-authorized).
- See [[release-engineering]], [[test-immutability]],
  [[flakes-are-bug-reports]].
