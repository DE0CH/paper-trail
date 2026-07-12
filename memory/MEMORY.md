# Project: Paper Trail (+ parent arXiv 2411.01678 W*-categories paper)

This memory lives IN the repo at memory/ (git-tracked). The repo is at
~/Documents/cs/paper-trail (moved 2026-07-12 from
~/Downloads/arXiv-2411.01678v1/paper-trail); ~/.claude/projects memory
symlinks for the new path AND both old project dirs all point here.
The PAPER (arXiv 2411.01678) stayed at ~/Downloads/arXiv-2411.01678v1
(not a git repo; see paper-build.md pointer below).

## Current state (2026-07-12, session 3)
- v0.5.8 PUBLISHED and verified (10 dash-named assets, updater urls
  200, deploy-web green): Software Update window, restart guards
  unsaved sessions, save-from-close data-loss fix (picker never
  settles after a canceled unload — close-prompt saves route to the
  shell dialog via 'save-from-close'), Windows Jump List New Window.
- v0.5.7 shipped the update-404 fix (space-free artifactNames +
  updateFeedNames test), release-gated Vercel deploy (deploy.yml
  DELETED), ci.yml cancel-in-progress concurrency. v0.5.6 SKIPPED;
  v0.5.5 repaired in place with 6 alias assets.
- v0.5.9 PUBLISHED and verified (10 assets, urls 200, deploy-web ok):
  NSIS graceful-close (build/installer.nsh customCheckAppRunning —
  asks, never taskkill /F, exit 4 on refusal), SILENT background
  updates (no icon progress/toast; install on quit; next start toasts
  "was updated to X" via userData last-version.txt marker + 'updated'
  pt-menu action), restart asks edited windows first (editedWindows
  set via pt-document-edited), mid-download re-check resumes progress
  view. Update window (0.5.8): update.html + src/update/main.tsx,
  ids pt-update-root[data-state]/-title/-detail/-progress/-primary/
  -secondary; menu-driven, mac-only entry point.
- Test battery added this session: updateWindow(+Edges),
  updateRestartUnsaved(+Edges), updateMacWindowInstall,
  updateMacCancelThenQuit (no self-relaunch after abandoned restart),
  updateWinQuitInstall (silent download→quit-install→stays
  closed→announcement), installerCloseUnsaved, newWindowTask,
  unitEdges, e2eEdges, desktopEdges. updateMacManualInstall retired
  (Test Deletion, owner-authorized). Harness gotchas learned: dev
  runs need dev-app-update.yml next to the entry module; playwright
  dialog listeners must answer beforeunload dialogs to MATCH intent
  (accept=leave) and never spawnSync while a debugger-attached app
  must close (frozen node stalls the close); shared updater cache
  between tests must be wiped; runner displays are 1024x768 (OS
  clamps window sizes).
- Native Win32 menus (src/desktop/winMenu.ts, koffi): validated
  visually via windows-screenshot.yml artifact; koffi EXCLUDED from
  mac bundles (universal-merge rejects per-arch prebuilds).
- .claude/settings.json (committed) bans force pushes via deny rules
  + PreToolUse hook; active from session start in paper-trail cwd.

## Paper Trail (this repo)
- Published: github.com/DE0CH/paper-trail (public), Vercel prod
  https://paper-trail-green.vercel.app (team-scoped URLs 302 behind
  Vercel auth — expected; deploys ONLY from release.yml's deploy-web
  job since 0.5.6, never on push), releases via .github/workflows/release.yml
  (v* tags -> signed+notarized universal mac zip+dmg, unsigned win;
  job FAILS if signing secrets missing — owner: never ship unsigned mac.
  Tested locally with `act workflow_dispatch -P macos-latest=-self-hosted`).
- ALL deployment steps in CI, never on the dev machine (CLAUDE.md rule).
- Signing (2026-07-10): local secrets in ~/paper-trail-signing/ (outside
  repo): devid.key/.csr/.p12 + p12-password.txt + AuthKey_3KNVH5BAC5.p8
  (ASC API key, ONE-TIME download, role Developer, Key ID 3KNVH5BAC5,
  Issuer 11025254-570b-463b-af34-00bf6b0e151e). Cert: "Developer ID
  Application: Deyao Chen (S64YL394S3)" expires 2031-07-11. GH secrets:
  MAC_CERT_P12 (base64), MAC_CERT_PASSWORD, APPLE_API_KEY_P8,
  APPLE_API_KEY_ID, APPLE_API_ISSUER, VERCEL_*. Notarization via
  electron-builder mac.notarize:true + APPLE_API_* env. Windows binaries
  still unsigned; owner leans Azure Trusted Signing but undecided.
- CLAUDE.md in repo root records the owner's rules — read it first.
- Session files: .ptl ("paper-trail-session v1" header). All legacy psr
  identifiers purged: protocol paper-trail://, hooks window.__pt,
  ptDesktop bridge, pt: storage prefixes.
- CI: windows-latest runs full e2e vs a GENERATED fixture pdf
  (src/test/fixture.ts; sample/ pdfs gitignored, .ptl fixtures
  committed) + packaged-exe smoke + desktopSave + desktopOffline
  regressions. Releases: universal mac + win, e2e first.
  act -P macos-latest=-self-hosted tests workflows locally.
- pdf.js cMaps + standard_fonts bundled to dist-web/pdfjs (CJK/offline;
  viewer passes cMapUrl/standardFontDataUrl via document.baseURI).
  vite-plugin-static-copy v4 preserves source paths by default: flatten
  with rename: { stripBase: true } per target. CJK regression fixture:
  sample/cjk.pdf (UniGB-UCS2-H, no embedded font) from tools/fixture.ts.
- Auto-update live since 0.5.0 (electron-updater, GitHub provider;
  release assets must include latest*.yml + *.blockmap). Interactive
  flow since 0.5.3: Update Now → icon progressbar → Restart Now prompt
  (restart closes windows via the unsaved prompt; menu item id
  'check-updates'). Test seams: PT_UPDATE_URL (generic feed +
  forceDevUpdateConfig), PT_UPDATE_TEST=download|install.
- CI shape (owner-mandated): TWO jobs (windows, mac — steps genuinely
  differ) × runner matrix for arch: [windows-latest, windows-11-arm],
  [macos-latest, macos-15-intel]. Each: unit, browser e2e, desktopE2e
  (FULL e2e suite duplicated for Electron, offline via harness-side
  webRequest block), 3 desktop harnesses, package, installer test,
  update test (win: real install→update→verify version+smoke; mac:
  download-only — Squirrel refuses unsigned installs — plus scripted
  manual menu flow).
- Windows-ARM installer bug (fixed): 7-Zip ≥22 packs arm64 binaries
  with the ARM64 branch filter; NSIS's Nsis7z can't decode → exes/dlls
  silently dropped. Fix: ELECTRON_BUILDER_7Z_FILTER=BCJ2 env on every
  electron-builder --win invocation (ci+release). NSIS = assisted
  wizard (oneClick:false) with Desktop+Start Menu shortcuts.
- Update-test harness gotchas: latest*.yml urls are URL-safe (spaces→
  dashes) but on-disk artifacts keep spaces — feed server must map;
  never spawnSync while the harness hosts the feed (blocks accepts);
  electron-updater's "Cannot download" message omits the port.
- ARTIFACT NAMES MUST NEVER CONTAIN SPACES (the 0.5.x update-404 bug):
  GitHub renames uploaded release assets spaces→DOTS while the ymls
  say spaces→DASHES → every published update check 404ed on BOTH
  platforms; the harness feed-server name mapping masked it in CI.
  Fixed via explicit artifactName patterns (package.json build:
  mac/dmg/nsis/win) + src/test/updateFeedNames.ts (yml urls must
  exist on disk verbatim + no spaces), run after every packaging
  step. Suffixes are load-bearing: installerMac globs "-mac.zip",
  win tests glob /Setup.*\.exe$/i, release.yml globs "*-win.zip".
- NEVER force push (owner rule, absolute): no `git push -f`/--force,
  on any ref, branch or tag, for any reason. Everything is
  append-only: fix forward with new commits and new tags.
- Release process (owner rule, 2026-07-12): after pushing to main,
  WAIT for the branch CI run to complete and SUCCEED before bumping
  the version and tagging. The release workflow's ci gate is only a
  guard, never the validation vehicle.
- NEVER reuse a version number (owner rule): if a version failed to
  build or its release was blocked by failing CI, skip that version
  and bump to the next one — no `git tag -f`, no tag moving, ever.
  Rename the unshipped CHANGELOG section to the new version AND add a
  "## <ver> (skipped)" section recording why it was skipped.
- Owner pushes concurrently: if a push is rejected AFTER a tag went
  up, cancel the stale release run and ship the next version number
  (see above — never move tags).
- Releases gate on the full CI pyramid via a reusable workflow_call of
  ci.yml INSIDE release.yml — yes this duplicates the branch-push CI
  run; owner explicitly prefers the clearer self-contained logic over
  saving runners (rejected a wait-for-branch-CI dedup; reverted).
- npm run media regenerates README media (mp4 + screenshots, cursor+key
  HUD overlay); it SELF-VERIFIES content (distinct labels, depth,
  branches) — user rule after eyeball review missed repeated labels.
- User rules: capture transcripts to docs/transcripts/ pre-compaction;
  parallelize with agents/background tasks where possible; final answers
  at the END of my reply; 3-letter file extensions, high-entropy names.
- gh CLI authed (DE0CH), vercel CLI authed (de0ch); installing deps
  pre-approved; user keeps a notes file and may ask to be reminded.
- v0.3.4 shipped signed+notarized (verified: spctl "Notarized Developer
  ID"). Desktop shell (src/desktop/main.ts): multi-window, OS file
  opens via pt-open-file IPC (+ per-window ready queues), hiddenInset
  traffic lights (body.desktopMac drag region), Save/Don't Save/Cancel
  close prompt, file associations; smoke accepts a file arg to test the
  OS-open path; PT_DEBUG=1 traces. Icons: ALWAYS inline SVG
  (src/ui/icons.tsx), never unicode glyphs (user rule). Root font 13px
  → 1rem=13px, all Tailwind spacing scales by 0.8125. e2e now 76
  checks. Menu shows real single-key accelerators (M/Shift+M/T);
  renderer re-inserts the char when a text field has focus.
- Rows: fixed-height, rename input reproduces the span box exactly (no
  layout shift) — user is very sensitive to UI jank/misalignment.
  NEVER claim alignment from eyeballing screenshots: measure pixel
  centroids numerically (ffmpeg png→raw + python analysis) and compare
  centers with tolerance.
- macOS Tahoe (26): Electron trafficLightPosition is IGNORED (measured:
  identical for y:9 vs y:26); window-ID captures (screencapture -l)
  EXCLUDE the traffic lights (separate OS layer) — only full-screen
  captures show them, and they're gray when unfocused. PT_SHOT=1 env
  shows a dev window WITHOUT stealing focus; PT_USERDATA isolates
  profile+single-instance lock from the installed app.
- NEVER launch always-on-top/focus-stealing windows on the user's
  machine (explicit complaint). NEVER edit files via python/shell —
  Edit/Write tools only; on "file modified" conflicts re-read & retry
  (user edits concurrently). Owner instructions ≠ contributor docs;
  docs in full sentences, no dev war stories. No Linux builds exist.
- Acknowledge every mid-work user message in the very next reply
  (briefly), don't batch acknowledgments to the end. On push rejection:
  git pull (rebases) then push. All shortcuts modifier-based (not vim);
  no "branch" noun in user copy — only multiple trails / duplicating.
- Shortcut gotchas: mod+E and mod+Shift+E are browser-owned (never
  reach the page); re-anchor = mod+G. mod+F toggles the find bar.
  Electron menu clicks have NO user activation → renderer file pickers
  throw SecurityError; menu Load/Save go through main-process dialogs
  (test: npm run test:desktop, dialog stubbed).
- Open-routing rules: PDF picked/OS-opened while a doc is open → NEW
  window (desktop, pt-open-new-window IPC) / NEW tab (web, window.open
  + postMessage File handoff, initTabHandoff); empty windows reused;
  pdf drag-drop no-op when doc open (session drops OK). Recents =
  pdf+session pair, all-or-nothing with file-specific error.
- Error dialogs/toasts must name the exact failing thing, not either/or.
- Windows: no universal binary; NSIS packs x64+arm64 in one installer
  (win.target arch list). Fluent title bars with content = 48px.
- Parallel agents: OK to edit via isolation:"worktree" branches, the
  orchestrator merges; shared build outputs forbid same-tree parallel
  builds. Desktop e2e-ish harnesses: patch electron dialog before
  require(main.js) (src/test/desktopSave.ts pattern).
- Demo video re-upload flow: commit mp4 → raw.githubusercontent fetch
  in a GitHub new-issue page → synthetic ClipboardEvent paste into
  textarea[aria-label="Markdown value"] → grab user-attachments URL →
  clear draft → README; verify player headlessly (autoplay flag).

## Product/design facts
In memory/product-design.md (trails model, session-file philosophy,
two-file flow, preview/panels/rendering rules, perf limits, pdfjs v6
gotchas, stable test hook ids).

## User preferences (confirmed)
- Tests are IMMUTABLE: in no case edit/modify an existing test — only
  ADD tests. Removal only in limited cases (a feature change that
  justifies it). "DRY does not apply to tests": duplicate suites
  rather than share/parametrize test code. (Owner halted a suite
  parametrization refactor mid-flight over this; reverted.)
  If a change requires a test to change: finish ALL requested work
  with the test failing, STOP, ask permission. Test modifications/
  deletions go in special commits containing ONLY test changes; a
  normal commit must never MODIFY tests. ADDING tests is always fine,
  needs no permission, and may be mixed into normal commits. Renaming
  a test or editing test comments is also fine — only the test CODE
  is guarded. STRICT: red (-) lines / deletions over a test file are
  allowed for exactly ONE reason — a test is failing that should not
  be failing (the test itself is wrong) — and that ALWAYS requires the
  owner's explicit permission first. This covers uncommitted
  just-added test code too. Needing different logic in a test = write
  a NEW test containing the new logic (even for a minor change), never
  patch. Any commit whose diff has red (-) lines in a test file MUST
  start its commit message with "Test Deletion". THE reason (owner's
  words): tests are contracts the owner enforces onto the project;
  the agent is not allowed to change the contract unilaterally — only
  the owner has that right.
- Non-test tooling (media/icons/perf/fixture generators) lives in
  src/tools/, not src/test/.
- Commit per feature/iteration; draft→commit, post-debug→commit. Signed
  commits via Bitwarden SSH key: on "No private key found" the user must
  approve in Bitwarden GUI — tell them, then retry.
- NEVER run tests locally (rule tightened 2026-07-12, supersedes the
  old "web e2e OK locally"): ALL tests run on GitHub runners only.
  Local `npm run build` (compile) is fine.
- MERGE branches, never cherry-pick ("there aren't many good reasons
  to cherry pick" — owner, 2026-07-12), and always merge with
  --no-ff: a branch integration always gets a merge commit.
- Watchers ALWAYS get a timeout (owner rule): cap the watcher process
  (~45 min for CI runs) so a stuck watcher wakes Claude to re-check
  instead of blocking progress — the timeout kills only the WATCHER,
  never the watched run. Pattern: background `gh run watch` + guard
  loop that kills it after N minutes and prints a timeout marker.
- CI must report ALL failures in a run, never fail fast, AND keep
  per-suite verdicts visible in the step list (owner rejected an
  aggregating shell loop for hiding which suite failed): one step per
  suite, each `if: ${{ !cancelled() }}`; the web server starts in its
  own step (background processes outlive steps on runners); only
  artifact-dependent chains (package→smoke→installer) stay gated.
- Tests/automation: headless playwright-core with installed Edge/Chrome,
  never their browser. Exception: when the user explicitly asks to watch
  (claude-in-chrome on their tab; small step first, confirm they see it).
- Taste: frameworks + CSS tooling over hand-rolled; TypeScript; Python over
  shell; plain-text git-friendly formats; standard "fragile" undo semantics;
  no gratuitous TCP; don't over-emphasize obvious design points in docs.

## Paper HTML/PDF build
Details in memory/paper-build.md (make4ht+fix-mathml pipeline, native
MathML only — no MathJax; applied WStarCats.tex fixes; headless-Chrome
verification techniques). Entry: `./build-html.sh`; PDF: pdflatex x2.

## Environment notes
- PIL is broken (missing libtiff dylib); use `sips` for image ops
- User's viewers: Edge (likes cmd+click refs → new tab), macOS Preview, Sioyek+Skim installed
