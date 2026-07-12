# Project: arXiv 2411.01678 (Complete W*-categories paper)

## Subproject: Paper Trail (own git repo in ./paper-trail)
- Published: github.com/DE0CH/paper-trail (public), Vercel prod
  https://paper-trail-green.vercel.app (team-scoped URLs 302 behind
  Vercel auth — expected), releases via .github/workflows/release.yml
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
- NEVER force push (owner rule, absolute): no `git push -f`/--force,
  on any ref, branch or tag, for any reason. Everything is
  append-only: fix forward with new commits and new tags.
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

## (older notes, folder since renamed from pdf-stack-reader)
User-facing name: "Paper Trail"; UI says "trails", never "stacks"
(technical terms stay internal). PDF reader: parallel history trails
(browser back/forward, cmd+click branches, snapshot undo/redo capped 50
oldest-dropped, entry anchors immutable on scroll — explicit ⌖ re-anchor),
.psr reading-session files (line-oriented plain text v2, ordered trails,
no ids — user refuses JSON), explicit two-file flow (NO path resolution:
PDF-first + "Load session…" w/ confirm; session-first + prompt; mismatch
banner w/ "Use this PDF"; ⇄ Replace PDF keeps history), page-width
scrollable/resizable hover preview, outline+thumbnails nav panel
(closable, leftmost), independent panel widths (neighbors shift, never
resize), device-pixel-exact rendering (uncapped dpr, 64M px area cap,
backing/css exact ratio), pinch = ctrl+wheel re-render zoom.
Perf limits (measured, unenforced): localStorage auto-resume hard-fails
~63k entries; UI soft-slow ~20k entries in active trail.
- Stack: TS strict + React + Vite + Tailwind v4; pdfjs-dist v6 (npm);
  Electron shell over custom psr:// protocol (user: NO TCP in desktop app);
  node server only for browser mode; Python scripts (user: NO shell scripts).
- Build: `npm run build`; test: `npm start` then `npm test` (headless e2e,
  playwright-core + local Edge binary, 26 checks). README has details.
- pdfjs v6 gotchas: text layer sized by CSS rules on --font-height/--scale-x/
  --total-scale-factor (globals.css); loadingTask.destroy();
  convertToViewportRectangle removed; getDocument({data}) detaches buffer.
- Test hooks: window.__psr; keep element ids (#stacksPanel, .pdfLink,
  .searchHl, #resizeSidebar...) stable for e2e.

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
