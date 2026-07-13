# Project: Paper Trail (+ parent arXiv 2411.01678 W*-categories paper)

Memory lives IN the repo at memory/ (git-tracked); every ~/.claude
project dir symlinks here. Repos: ~/Documents/cs/paper-trail (mac box),
~/paper-trail-main (this 4GB orchestrator box). The PAPER stayed at
~/Downloads/arXiv-2411.01678v1 (not a git repo; see paper-build.md).

## Current state (2026-07-12, session 4 in flight)
- docs/handoff.md = authoritative to-do: native update UI rebuild,
  update-flash-close investigation, queue green, release v0.5.12.
- preview-rebuild MERGED into main (ec848e2) after green 29210950829.
- update-flash-close: witness rebuilt (freeze installer via
  NtSuspendProcess, reopen mid-install); fix 6925b16 reverted on
  branch awaiting red run 29211903833, then re-apply + fix the
  Start-Process arg-quoting bug (PS 5.1 joins unquoted).
- Owner spotted an undiagnosed problem in update-ui.mov (run
  29209950363 artifact) — review frames via CI artifact, fold into the
  new native-flow recording.
- tauri-experiment branch = separate Linux-box session; hands off
  (src-tauri/, src/test/tauriE2ePage.ts sit untracked here — leftovers,
  they break local tsc; not mine).
- v0.5.11 = latest release. History: [shipped-versions](shipped-versions.md).

## Active: CI/repo arrangement (2026-07)
- [infra-migration-2026-07](infra-migration-2026-07.md) — origin=public
  de0ch/paper-trail (GitHub Actions, canonical); mirror=private
  de0ch-org/paper-trail-mirror (`git push mirror <b>` for MANUAL Depot
  runs via owner-keyed dynamic runs-on). Refs stay DE0CH. An
  ORCHESTRATOR Claude coordinates this + the tauri agent — its messages
  are authoritative direction. Browser-only blockers: escalate.

## Hard rules (owner)
- NEVER force push — any ref, any reason; append-only, fix forward
  (.claude/settings.json deny rules + hook enforce it).
- [Tests are IMMUTABLE contracts](test-immutability.md) — never edit
  test code without permission; "Test Deletion" commit protocol.
- NEVER run tests locally — ALL tests on GitHub runners only.
- [Orchestrator-only machine](orchestrator-only-machine.md) — this 4GB
  box: git/gh/edits only; no builds, no app runs, no media processing
  (OOM-crashed); ALL computation via GitHub Actions.
- MERGE with --no-ff, never cherry-pick.
- [Parallel CI-bound TDD](tdd-parallel-ci.md) — run fix-reverted (red)
  and fix-applied (green) variants concurrently; use a focused
  single-test workflow, not the full pyramid, for fast iteration.
- [Flakes are bug reports](flakes-are-bug-reports.md) — root-cause and
  pin with a deterministic test.
- [Existing components over custom](existing-components-over-custom.md)
  — native/stock over hand-drawn (scrollbars, doc icons, installer).
- NEVER reuse a version number; skip and document. Details:
  [release-engineering](release-engineering.md).
- Deployment/signing/releases happen in CI only; dev machines push
  commits and tags. Release = dev CI green → bump+tag together.
- Owner pushes concurrently: on push rejection, git pull (rebases per
  .gitconfig) and push again.

## Topic files
- [release-engineering](release-engineering.md) — release rules,
  signing secrets, artifact naming (NO SPACES — the update-404 bug),
  Vercel, act.
- [ci-testing](ci-testing.md) — CI job shape, fail-fast ban, harness
  gotchas (feeds, spawnSync, dialogs, runner quirks), coverage.
- [shipped-versions](shipped-versions.md) — v0.3.4→v0.5.11 history +
  what's on main unreleased.
- [desktop-shell](desktop-shell.md) — Electron shell, IPC, menus,
  platform quirks (Tahoe traffic lights, koffi, NSIS), update seams.
- [ui-conventions](ui-conventions.md) — inline-SVG icons, no-jank rows,
  shortcuts, open-routing, error-message precision.
- [media-pipeline](media-pipeline.md) — media.yml recording,
  self-verification, demo-video upload flow.
- product-design.md — trails model, session-file philosophy, panels,
  perf limits, pdfjs v6 gotchas, stable test hook ids.
- paper-build.md — make4ht+fix-mathml pipeline (native MathML, no
  MathJax), WStarCats.tex fixes; `./build-html.sh`; PDF: pdflatex x2.

## Workflow preferences
- Capture the session transcript (~/.claude/projects/<project>/
  <session>.jsonl, gzipped) into docs/transcripts/ BEFORE compaction;
  commit it. Naming: session-N.
- Commit per feature/iteration; draft commit before debugging. Signed
  commits via Bitwarden SSH key: on "No private key found" the owner
  must approve in the Bitwarden GUI — say so, then retry.
- Parallelize with agents/background tasks; final answers at the END of
  the reply; acknowledge every mid-work user message in the very next
  reply. 3-letter file extensions, high-entropy temp names.
- Background-work heartbeat (owner rule): whenever a background command
  is expected to wake Claude on completion, ALSO set a 5-minute
  ScheduleWakeup alarm that does nothing but wake; the woken agent
  decides what to do.
- Parallel agents: edit via isolation:"worktree" branches, orchestrator
  merges; shared build outputs forbid same-tree parallel builds.
- gh CLI authed (DE0CH), vercel CLI authed (de0ch); installing deps
  pre-approved; owner keeps a notes file and may ask to be reminded.
- Taste: frameworks + CSS tooling over hand-rolled; TypeScript; Python
  over shell; plain-text git-friendly formats; standard "fragile" undo;
  no gratuitous TCP; don't over-emphasize obvious points in docs.
- Owner instructions ≠ contributor docs; docs in full sentences, no dev
  war stories. Edit files ONLY with Edit/Write tools; on "file
  modified" conflicts re-read & retry. No Linux builds exist.

## Environment notes
- Mac box: PIL broken (missing libtiff dylib); use `sips` there. This
  box: NO local media tools at all (orchestrator-only rule).
- Owner's viewers: Edge (cmd+click refs → new tab), macOS Preview,
  Sioyek+Skim installed.
