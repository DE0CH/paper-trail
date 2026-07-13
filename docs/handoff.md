# Paper Trail — Session Handoff (2026-07-13)

This replaces the previous handoff. It is written for a **fresh Claude Code
session resuming in the cloud** (claude.ai/code / Claude Code on the web),
because the local orchestrator box is being retired for this work. Read it
top to bottom, then read `CLAUDE.md` and `memory/MEMORY.md` (now imported
into `CLAUDE.md` — see §7). A companion agent (the tmux `agent` session
doing the Tauri port) is being moved too and is writing its own handoff.

The context window is large by request — this is deliberately exhaustive.

---

## 0. Migration context (read first)

- The **local machine** running this session was a 4 GB Linux
  "orchestrator-only" box: it could do git / gh / file edits but **could
  not build, run the app, run tests, or process media** (it OOM-crashed).
  Everything computational was pushed to **GitHub Actions**.
- The **cloud session inherits none of that machine's constraints or its
  local state.** In particular a cloud VM can very likely `npm run build`
  and may be able to do more locally. Do **not** blindly carry over the
  "orchestrator-only, no local builds" rule — that was about *that box*.
  (Tests still run on GitHub runners by owner rule — see §6/§9.)
- Local-only assumptions baked into `CLAUDE.md` and `memory/` are
  enumerated in **§6** — check them before trusting them in the cloud.

---

## 1. TL;DR — state right now

- **v0.5.13 is shipped, verified, and live.** (v0.5.12 was skipped — see §3.)
- **On `main`, unreleased:** two app fixes ready to ship — the `.ptl`
  slow-reveal fix and the search committed/uncommitted feature — plus
  mac-update **recorder tooling** tweaks (not shipped in the app bundle).
- **In flight, NOT finished — pick up (see §4):**
  1. **Flash-close silent cancel/defer** — owner-decided behavior; the fix
     is committed on `origin/flash-close-silent` but its witness never went
     green and **Mac TDD was never done**. This is the top priority.
  2. **A release** bundling the two merged fixes (+ flash-close once green).
- **Abandoned/superseded:** the Windows "marquee" recording (§5).
- **Companion agent:** the tmux `agent` session is doing a **Tauri v2 port
  experiment** (branches `tauri-experiment*`); it is being moved to cloud
  too and is writing its own handoff. Leave its branches alone.

---

## 2. Repo, remotes, CI architecture

- **origin = `de0ch/paper-trail` (PUBLIC, GitHub Actions, canonical).** All
  refs and the electron-builder publish config say `DE0CH`.
- **mirror = `de0ch-org/paper-trail-mirror` (PRIVATE)** — used only for
  MANUAL Depot runs (`git push mirror <branch>`), owner-keyed dynamic
  `runs-on`. Not the automatic CI. (The mirror remote is configured on the
  *local* box; a cloud checkout may not have it — see §6.)
- **CI (`.github/workflows/ci.yml`)** runs on every push to `main`, every
  PR, and via `workflow_call` from `release.yml`. Matrix is **static +
  owner-keyed `runs-on` expression** (NOT `fromJSON` — that broke
  `workflow_call`). Windows `{windows-latest, windows-11-arm}`, mac
  `{macos-latest, macos-15-intel}`; the `de0ch-org` owner routes some to
  Depot runners. `ci.yml` requests `permissions: id-token: write` for the
  Codecov OIDC upload.
- **`release.yml`** triggers on `v*` tags. It gates on the full CI pyramid
  (`uses: ./ci.yml`), then builds **signed+notarized** universal mac
  (zip+dmg) + Windows (nsis + zip, x64/arm64), attaches them to a GitHub
  Release, and deploys the web app to **Vercel prod**. It **must** grant
  `id-token: write` at top level or it startup-fails calling `ci.yml`
  (this is exactly what skipped v0.5.12 — see §3).
- **Review/recording workflows** (`workflow_dispatch`): `media.yml`,
  `mac-screenshot.yml`, `mac-scrollbar.yml`, `mac-update-ui.yml`
  ("macOS update UI recording"), `windows-screenshot.yml`,
  `windows-file-icons.yml`, `resilience-mac.yml`, `witness-resilience-win.yml`,
  `witness-flash-close.yml`, `witness-ptl-reveal.yml`, `witness-search-commit.yml`,
  and (on the `flash-close-recording` branch only) `flash-close-recording.yml`.
- **Release rules (owner, strict):** CI green **before** the version bump;
  bump + tag together; **NEVER reuse a version** (skip it, rename the
  CHANGELOG section, add a `## <ver> (skipped)` note); **NEVER force-push
  any ref**; **MERGE with `--no-ff`, never cherry-pick**; every release
  needs a `## <version>` CHANGELOG section (the workflow refuses without
  one). Artifact names **must never contain spaces** (the 0.5.x update-404
  bug — GitHub renames spaces→dots while the ymls say spaces→dashes;
  `src/test/updateFeedNames.ts` guards it).

---

## 3. What was accomplished this session (chronicle)

### 3a. v0.5.13 release recovery (DONE)
- **v0.5.12 startup-failed** at release time. Root cause (confirmed via a
  throwaway `wfcall-test` branch that flipped from `startup_failure` to
  `queued` the moment the caller got the permission): the reusable `ci.yml`
  requests `id-token: write` (Codecov OIDC, added after 0.5.11) but
  `release.yml` (the caller) only granted `contents: write` — **a called
  workflow can't exceed its caller's permissions → GitHub refuses to start
  it.** Fixed by adding `id-token: write` to `release.yml` (commit on main).
  Also rewrote `ci.yml`'s owner-keyed matrix from `fromJSON` to static +
  `runs-on` (workflow_call-safe).
- **v0.5.12 was SKIPPED** (never reuse a version). Bumped to **0.5.13**,
  renamed the CHANGELOG section, added `## 0.5.12 (skipped)`.
- Shipped **v0.5.13**: tagged, `release.yml` ran green, 10 dash-named
  assets published, updater feeds (`latest.yml`, `latest-mac.yml`) return
  200, `deploy-web` green. Verified post-publish.
- v0.5.13 content (see CHANGELOG): **Sparkle-style native macOS Software
  Update window** with an interruptable Cancel; native doc icons; new app
  icon; native scrollbars; no-flash windows; the **.ptl-then-PDF
  save-binding fix**; **mac + Windows update-resilience tests** (SIGKILL /
  `taskkill /F`, mid-install kill, corrupt download — electron-updater's
  atomic staging proved resilient, no product bug). `update-flash-close`
  was **cut** from this release (see §4).

### 3b. Two macOS update videos (DELIVERED)
- Delivered two `.mov`s to the owner via the "macOS update UI recording"
  workflow (`mac-update-ui.yml` + `src/tools/updateWindowRecord.ts`),
  watched back frame-by-frame first:
  - **finished:** offer → Update Now → progress bar → "Ready to update" →
    Restart to Update.
  - **canceled:** offer → downloading → **Cancel stops the transfer
    mid-download and returns to the offer** (end frame is the offer, not
    "Ready to update").
- Getting the *canceled* take right took **three earned recorder fixes**
  (all on `main`, they are TOOLING not app code):
  1. `clearUpdaterCache()` before each launch — the real root cause: the
     finished run's completed 0.6.0 download persisted in
     `~/Library/Caches/<updaterCacheDirName>` (NOT redirected by
     `PT_USERDATA`), so the canceled run's `autoDownload` validated the
     cached zip and hit `downloaded` before Cancel could fire.
  2. The canceled feed **stalls at ~65% and never completes**, so the fresh
     download stays `downloading` until Cancel aborts it.
  3. **Retry the Check-for-Updates menu gesture** until the update window
     opens (a one-off macOS menu-click flake).

### 3c. `.ptl`-then-PDF save-binding fix (SHIPPED in v0.5.13)
- Bug: open a `.ptl` then its PDF (same window) → auto-save stopped and
  manual Save re-prompted for a location. Fixed via a fork with parallel
  red/green TDD, witnessed RED on both mac and Windows.

### 3d. `.ptl` slow-reveal fix (MERGED to main, unreleased)
- Bug (owner): double-clicking a `.ptl` shows the window only after the
  ~4 s fallback reveal timer. **Root cause:** `enterPendingState`
  (`src/core/controller.ts`) — the state a `.ptl` opened *without its PDF*
  lands in — set no `document.title`, so the desktop shell's title-driven
  reveal (`createWindow`'s `showWhenLoaded`, `src/desktop/main.ts` ~line
  252) never fired. **Fix:** set `document.title = \`${json.pdf.name ||
  'Reading session'} — Paper Trail\`` in `enterPendingState`.
  - Test: `src/test/osOpenSessionReveal.ts`; wired into both os-open jobs
    in `ci.yml` + focused `witness-ptl-reveal.yml`.
  - Red/green: RED `29262319064` (fails, bare title), GREEN `29262265330`
    (passes, revealed by session title). Merged as `22bf7be`.

### 3e. Search committed/uncommitted states (MERGED to main, unreleased)
- Owner spec: a search history entry has two **in-memory-only** states.
  **Uncommitted** right after a search — more find-next (Enter) overwrites
  the same entry; scroll/zoom keep it uncommitted. **Committed** — reached
  by an action meaning **"the user found what they were looking for and
  moved on"**; the next search then adds a *new* entry.
- Design evolution (important — the owner corrected me twice):
  1. First framed as "commit on everything **except** next/scroll" — a
     *negative* match. **Wrong:** there is no global action dispatcher, so
     you can't hook it once; you'd have to touch every action and silently
     break when a new action is added.
  2. Corrected to a **positive match**: an explicit, enumerated list of
     committing actions, each calling `commitSearch()`.
  3. Governing **principle** (owner): an action commits iff it means
     "found it and moved on."
- Implementation (`src/core/controller.ts`): `commitSearch()` = `this.
  searchEntry = null`. `gotoMatch` keeps the belt-and-suspenders guard
  `if (this.searchEntry && this.hist.current === this.searchEntry)` (so a
  future un-hooked cursor-mover degrades to "push a new entry" instead of
  corrupting). `commitSearch()` is called from: `jumpVia`
  (link/outline/gotoPage/mark), `goBack`, `goForward`, `histEntryClick`,
  `stackSwitch`/`stackNew`/`stackClose`/`stackDuplicate`, `entryRename`/
  `stackRename`, `saveProgress` (explicit Save — **not** `writeProgress`
  auto-save), `replaceWithFile`, and the correctness set `clearHistory`/
  `entryRemove`/`entrySetPos`/`undoHist`/`redoHist`. The **search-box
  dismiss** is hooked in `SearchBar.close()` (Esc/×) and `App.closeSearch`
  (mod+F). **Not** hooked (stay uncommitted): `gotoMatch`, `runSearch`,
  scroll, `zoomIn/zoomOut/fitWidth/refitIfNeeded`, `writeProgress`
  (auto-save), `removeRecent`, and the banner actions
  `adoptCurrentPdf`/`dismissMismatch` (orthogonal to search).
- Test: `src/test/searchCommitState.ts` (counts `"…"`-labelled entries via
  deltas; `'the'` = 262 matches, version-agnostic); focused
  `witness-search-commit.yml`; wired into both web-e2e jobs in `ci.yml`.
  Red/green: RED `29264239294` (8/10, fails only Save + dismiss — the true
  differentiators), GREEN `29264547082` (10/10 after the guard hardening).
  Merged as `ee2d896`.

### 3f. Flash-close decision (owner) + partial implementation — see §4.

### 3g. Infra / housekeeping this session
- Deleted merged branches: `update-resilience-mac`, `update-resilience-win`,
  `fix-ptl-then-pdf-binding`, `fix-ptl-slow-reveal`, `search-commit-states`,
  `wfcall-test`, and a throwaway `test-branch` (a scratch commit from a
  different session).
- **Signing** churned but nets out simple — see §8. Bottom line: **commits
  are signed** (locally via the Bitwarden/Goldwarden ssh-agent; in the
  cloud automatically via the GitHub container).

---

## 4. IN-FLIGHT — pick these up (priority order)

### 4a. Flash-close: silent cancel/defer (TOP PRIORITY, NOT finished)

**Owner decision (final):** if the user reopens the app **mid-update**, it
must **cancel/defer the update and bring up the OLD version SILENTLY** — no
flash-close, no marquee, no error. The double-clicked document opens on the
currently-installed (old) version; the downloaded update stays cached and
applies on the next clean quit (deferred, **not** lost). Full write-up:
**`docs/flash-close-finding.md`**.

Consequences of the decision:
- **Drop** the held fix's "Updating Paper Trail…" marquee — the handoff
  must be silent (`updateGuard.ts` / `handoffWhileUpdating`).
- Cancel the pending install **cleanly** (no half-replaced/corrupt files).
- **Relax the witness contract** — the owner explicitly authorized this
  test-contract change: drop the "the update still completes" assertion;
  assert instead **no flash-close** (app runs), **the document opens**, the
  app is the **OLD version** (update deferred), and **no corrupt/partial
  install**.

**Where it stands (partial):**
- Branch **`origin/flash-close-silent`** (tip `78eb6d2`
  "flash-close: silent cancel of the update on reopen-during-install") —
  the silent-cancel fix is implemented (Windows). Based on
  `update-flash-close-fixed` (`ada5354`, the held marquee fix whose safe
  old-version outcome was the base).
- Branch **`origin/flash-close-silent-red`** (tip `dc88eea`
  "RED variant: revert the silent-cancel fix (raw reopen flash-closes)").
- The witness CI run was cancelled during the move (**never confirmed
  green**). **Mac TDD was never done.**
- The **Windows witness** driver is `src/test/updateWinOpenDuringInstall.ts`
  (installs the NSIS Setup, downloads the pending update, arms an
  `NtSuspendProcess` freeze, quits → freezes the installer mid-replace,
  reopens with a spaced-name document, thaws, asserts). Focused workflow:
  `witness-flash-close.yml`. `update-flash-close` holds the original RED
  witness.

**TODO to finish it:**
1. Confirm/adapt the silent fix on `flash-close-silent`; witness **RED→GREEN
   on Windows** (RED = raw reopen flash-closes; GREEN = silent cancel →
   old version + document + no marquee + no corrupt).
2. **Add Mac TDD** — owner reminder, do **not** infer cross-platform. Mac
   uses **Squirrel.Mac** (atomic bundle replacement), different failure
   mode. Adapt the existing mac update harness (`build-node/test/updateMac*.js`
   — `updateMacInstall`, `updateMacWindowInstall`, `updateMacKillDuringInstall`,
   `updateMacInterruptResilience`, `updateMacCancelThenQuit`) on a macos
   runner. Witness RED→GREEN on Mac too. **If** Mac's atomic mechanism makes
   the scenario inherently safe with no genuine RED, do **not** fabricate
   one — lock the silent contract with a regression test and say so.
3. Check whether the marquee path is even reachable on Mac; the "silent"
   part may be trivially true there, but still prove cancel/defer +
   old-version + no-corrupt with a real Mac witness.
4. Merge `--no-ff`, then include in the release (§4b).

### 4b. Release the pending work (after 4a)
- Current version is **0.5.13**; next is **0.5.14** (or a minor if you
  prefer). Unreleased on `main` that needs shipping: the **.ptl slow-reveal
  fix** (§3d) and **search committed/uncommitted** (§3e), plus **flash-close
  silent** once merged.
- Steps: bump `package.json`, add a `## 0.5.14` CHANGELOG section covering
  those user-facing changes, commit, ensure `main` CI is green, then
  `git tag -a v0.5.14 -m v0.5.14 && git push origin v0.5.14`, and watch
  `release.yml` to green (assets dash-named; feed URLs 200; `deploy-web`
  green). This is the standing "after making changes, always ship a
  release" rule.

---

## 5. Abandoned / superseded

- **Windows "marquee" recording** (`flash-close-recording` branch,
  `flash-close-recording.yml`, `src/tools/flashCloseRecord.ts`). It was
  built to *show* the held-fix "Updating Paper Trail…" marquee, but the
  owner then decided the behavior should be **silent (no marquee)**, so the
  marquee is being removed — this recording documents a rejected approach.
  Its last run **hung ~1 h on an unbounded wait and was cancelled.** Do
  **not** re-run it. The branch can be deleted once you're comfortable.
  (`src/tools/flashCloseRecord.ts` has a reusable Windows `gdigrab`
  recorder + `NtSuspendProcess` freeze harness if a "before" clip is ever
  wanted; its waits need hardening first.)

---

## 6. Local-only vs cloud — things in CLAUDE.md / memory that DON'T carry over

These are written from the local box's perspective; re-evaluate each in the
cloud rather than obeying blindly:

- **"Orchestrator-only machine / no local builds, runs, tests, media"** —
  this was the 4 GB box's OOM constraint (`memory/orchestrator-only-machine.md`),
  **not** a universal rule. A cloud VM can likely build and do more. (Tests
  still on GitHub runners is a *separate*, still-valid owner rule — §9.)
- **Signing** — locally via the **`rbw` (Bitwarden CLI) ssh-agent**: its
  agent serves the SSH signing key from the unlocked vault at
  `/run/user/$(id -u)/rbw/ssh-agent-socket`, and `~/.bashrc` exports
  `SSH_AUTH_SOCK` there. Sign via the agent, never extract the key. Unlock
  with `rbw unlock`. Watch for a **stale `SSH_AUTH_SOCK`** pointing at the
  dead Goldwarden socket (`~/.goldwarden-ssh-agent.sock`) — override it to
  the rbw socket per-command. **In the cloud, signing is automatic** via
  the GitHub container's key — just commit. (Full detail in §8.)
- **Memory location** — memory lives in `memory/` in the repo (git-tracked,
  15 files). On the local box `~/.claude/projects/<project>/memory` is a
  **symlink** to `memory/`; the cloud won't have that symlink, so memory is
  now **imported into `CLAUDE.md`** (§7). Files are read directly from
  `memory/`.
- **Transcript capture** — the rule to gzip
  `~/.claude/projects/<project>/<session>.jsonl` into `docs/transcripts/`
  before compaction uses a **local path**; the cloud transcript location
  differs. Adapt or skip.
- **Auth** — `gh` (as `DE0CH`) and `vercel` (as `de0ch`) were authed on the
  local box; the cloud has its own auth. `git push mirror` (the private
  Depot mirror `de0ch-org/paper-trail-mirror`) is a **local** remote — a
  cloud checkout may only have `origin`.
- **Other machines** — memory mentions a **mac box** (`~/Documents/cs/paper-trail`,
  broken PIL → use `sips`) and owner viewer apps (Edge with cmd+click,
  Preview, Sioyek+Skim). None of that exists in the cloud.
- **Depot runners** — a manual dev-loop accelerator via the private mirror;
  keyed on `de0ch-org`. Not part of automatic CI and not needed to make
  progress.

---

## 7. Memory is now loaded via a CLAUDE.md import

- `CLAUDE.md` now contains **`@memory/MEMORY.md`** so the memory **index**
  loads into context even without the `~/.claude` symlink (which the cloud
  lacks). `MEMORY.md` is the one-line-per-memory index; the topic files it
  points to live in `memory/*.md` and can be `Read` on demand.
- Memory files worth reading early: `memory/MEMORY.md` (index),
  `release-engineering.md`, `ci-testing.md`, `desktop-shell.md`,
  `ui-conventions.md`, `shipped-versions.md`, `product-design.md`,
  `orchestrator-only-machine.md` (⚠ local-only, see §6),
  `infra-migration-2026-07.md`, `tdd-parallel-ci.md`,
  `test-immutability.md`, `flakes-are-bug-reports.md`.
- To keep writing memories in the cloud: write files into `memory/` and add
  a one-line pointer in `MEMORY.md`. (The local auto-memory system also
  read this same dir, so nothing is lost.)

---

## 8. Signing (summary)

- **Commits are signed via the `rbw` (Bitwarden CLI) ssh-agent** — using
  the agent, never extracting the key. `rbw-agent` serves the SSH signing
  key from the unlocked vault at `$XDG_RUNTIME_DIR/rbw/ssh-agent-socket`
  (i.e. `/run/user/$(id -u)/rbw/ssh-agent-socket`). `~/.bashrc` **already
  exports** `SSH_AUTH_SOCK` to that socket. git config:
  `commit.gpgsign=true` + `tag.gpgsign=true`, `gpg.format=ssh`,
  `signingkey=~/.ssh/id_ed25519_signing.pub`. Unlock with `rbw unlock`
  (check `rbw unlocked`).
- **Gotcha:** the old **Goldwarden** ssh-agent is dead —
  `~/.goldwarden-ssh-agent.sock` no longer exists. A shell that inherited a
  **stale `SSH_AUTH_SOCK`** pointing there will fail to sign
  ("No private key found" / "agent refused operation"); override it to the
  rbw socket for that command:
  `SSH_AUTH_SOCK=/run/user/$(id -u)/rbw/ssh-agent-socket git commit …`.
  (This is exactly what bit the earlier `docs/handoff.md` commit `d8cf1d8`
  — a stale sock made it commit unsigned; it stays unsigned because
  re-signing would need a forbidden force-push. All later commits sign.)
- **In the cloud: signing is automatic** (GitHub container, owner's account
  key) — just commit.

---

## 9. Owner rules & working preferences (condensed — full detail in CLAUDE.md + memory)

- **NEVER force-push** any ref (deny rules + hook enforce it). Append-only,
  fix forward.
- **NEVER reuse a version number** — skip and document (rename CHANGELOG
  section + add `## <ver> (skipped)`).
- **MERGE `--no-ff`, never cherry-pick.**
- **Tests are immutable contracts** — never edit test code without explicit
  permission ("Test Deletion" / contract-change protocol; the flash-close
  witness relaxation *was* authorized). See `memory/test-immutability.md`.
- **Never run tests locally — all tests on GitHub runners.** Compiling
  (`npm run build`) is fine.
- **Strict TDD for bugs:** reproduce → root-cause → write a regression test
  and **watch it fail** → fix → watch it pass. **Parallel red/green** (run
  the fix-reverted RED and fix-applied GREEN concurrently via a focused
  single-test workflow). **Witness RED on EACH platform** — never infer
  cross-platform coverage (this bit us on mac before).
- **Flakes are bug reports** — root-cause + pin with a deterministic test.
- **Prioritize `/fork` subagents for dev work**; parallelize independent
  work; give final answers at the END; acknowledge every mid-work user
  message in the next reply.
- **Correcting a record** (memory/docs/comments): DELETE the wrong
  statement and state only the current truth — never annotate "this was
  wrong, now X."
- **Existing/native/stock components over hand-drawn** (scrollbars, doc
  icons, installers, menus).
- **Edit files ONLY with Edit/Write** — never via python/shell. On "file
  modified" conflicts, re-read & retry (owner edits concurrently).
- **Product/design:** user-facing name "Paper Trail"; UI copy says *trail /
  branch / reading session*, never "stack/state". Save format is
  line-oriented plain-text `.ptl`, **never JSON**. Desktop apps must feel
  native and must not bind TCP ports (serve over `paper-trail://`). History
  anchors change only via explicit actions, never scrolling. Degrade
  gracefully (banners + recovery, never dead ends). Buttons don't resize on
  state; UI must not jump/flash.
- **Deployment/signing/releases happen in CI only.** After changes, ship a
  release.
- Owner pushes concurrently: on push rejection, `git pull` (rebases per
  `.gitconfig`) and push again.
- Keep audiences separate: instructions to Claude are NOT contributor docs.
  `CONTRIBUTING.md`/`README.md` are full-sentence user/contributor material,
  no dev war stories.

---

## 10. Companion agent — tmux `agent` session (Tauri port)

- A **separate Claude Code agent** runs in the tmux session named `agent`.
  It is doing a **Tauri v2 port experiment** of Paper Trail — Rust shell +
  OS WebView instead of Electron — with a size/perf comparison
  (Electron vs Tauri vs a planned native Swift/PDFKit + C#/WPF/PDFium
  rebuild). Branches: `tauri-experiment`, `tauri-experiment-e2e`,
  `tauri-experiment-mac`, `tauri-experiment-win`. It was mid-task
  ("write `docs/tauri-report/REPORT.md`", "remove the Electron shell after
  the perf baseline", "measure native binary sizes").
- It is **being moved to the cloud too** and has been asked (via tmux) to
  cancel in-flight work and write its **own** handoff. **Do not touch the
  `tauri-experiment*` branches** — they belong to that agent.

---

## 11. Key files & references

- `src/desktop/main.ts` — Electron main: windows, menus, `open-file`
  routing, the `showWhenLoaded` reveal (~line 252), the update state
  machine (`pt-update-*`, `autoDownload=true`, `startInteractiveDownload`,
  `cancelDownload`, `checkForUpdatesInteractive`).
- `src/core/controller.ts` — the app controller: search
  (`runSearch`/`gotoMatch`/`commitSearch`), history (`jumpVia`, `goBack`,
  `histEntryClick`, stacks), `enterPendingState` (the `.ptl` reveal fix),
  save (`saveProgress` vs `writeProgress` auto-save), open/replace/session.
- `src/ui/SearchBar.tsx`, `src/ui/App.tsx` — search-box dismiss commit hooks.
- `src/tools/updateWindowRecord.ts` — mac update-UI recorder (cache-clear +
  stalled feed + menu retry).
- `src/tools/flashCloseRecord.ts` — Windows flash-close recorder (superseded).
- `src/test/updateWinOpenDuringInstall.ts` — Windows flash-close witness.
- `src/test/osOpenSessionReveal.ts`, `searchCommitState.ts` — new regression
  tests this session.
- `docs/flash-close-finding.md` — the flash-close decision & contract.
- `package.json` `scripts` — the full test/tool surface (many
  `test:update:*`, `test:os-open-*`, etc.).

---

## 12. Branch triage on origin (as of the move)

- **Keep / pick up:** `flash-close-silent`, `flash-close-silent-red`,
  `update-flash-close` (§4a).
- **Owned by the Tauri agent — leave alone:** `tauri-experiment`,
  `tauri-experiment-e2e`, `tauri-experiment-mac`, `tauri-experiment-win`.
- **Superseded — delete when comfortable:** `flash-close-recording` (§5).
- **Likely stale (verify merged into `main`, then delete):**
  `mid-upgrade-recording`, `native-update-ui`, `sparkle-update-window`,
  `mac-native-doc-icons`. Don't delete blind — confirm their commits are on
  `main` first.
- `main` — the trunk; unreleased app work waiting for the release (§4b).
