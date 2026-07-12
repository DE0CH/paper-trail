# Session handoff — main line (2026-07-12, end of session 3)

You are a fresh Claude Code session on a new computer, taking over the
MAIN line of work. Setup first:

1. Clone github.com/DE0CH/paper-trail, work on `main`.
2. Symlink your auto-memory to the repo's git-tracked memory:
   `rm -rf ~/.claude/projects/<project-slug>/memory && ln -s
   <absolute-repo-path>/memory ~/.claude/projects/<project-slug>/memory`
   (slug = repo path with `/` → `-`; dir exists after first session).
3. Read CLAUDE.md and memory/MEMORY.md — every rule applies: tests run
   ONLY on GitHub runners, strict witness-first TDD for bugs, one
   commit per feature, never force-push, never reuse versions, flakes
   are bug reports (root-cause + deterministic test), native/stock
   components over anything hand-drawn, releases: dev CI green →
   bump+tag together.

Branch inventory: `tauri-experiment` belongs to a DIFFERENT session on
a Linux box (docs/tauri-handoff.md) — hands off. `preview-rebuild` and
`update-flash-close` are yours, mid-cycle, below. Old worktrees lived
on the previous machine; just use the branches.

## In flight, in priority order

### 1. preview-rebuild branch — merge when green
Witnessed red on run 29209862293 (Preview.show() bailed when pdf.js
rebuilt the hovered link — the intermittent "hover preview never
became visible" flake was this real bug). Fix + airtight witness are
committed (49532c9); validation run 29210950829 was queued. If green:
`git merge --no-ff preview-rebuild` into main, push, delete the branch
(local + origin). If red: read the verdicts and fix forward.

### 2. Software Update UI: rebuild as NATIVE macOS prompts (owner order)
The owner reviewed the current update window (custom update.html/CSS)
and ruled it wrong: **it must use native macOS prompts, not something
built with CSS.** Design accordingly, e.g. dialog.showMessageBox
(NSAlert) for checking/available/up-to-date/ready/error, and a native
progress surface for downloading (Dock icon progress via
setProgressBar; no HTML window). Keep the wording; keep actions
Update Now / Later / Restart to Update. Port the affected tests
SEMANTICALLY (they assert pt-update-* DOM ids today): updateWindow,
updateWindowEdges, updateRestartUnsaved, updateMacWindowInstall,
updateMacCancelThenQuit — same contracts (states, cancel/save
interplay, no self-relaunch), new native seams. src/update/,
update.html, updatePreload and the update-window code in
src/desktop/main.ts get removed once the native flow passes.

Owner review deliverable (after the rebuild): a FULL-DISPLAY screen
recording (not window-content frames) of the real flow with the cursor
visible: click "Check for Updates…" in the app menu → prompt appears →
cursor moves to Update Now → click → download progress → cursor to
Restart to Update → click. Drive the menu with osascript System Events
(UI scripting works on the runners — a CoreServicesUIAgent dialog was
clicked that way earlier); record with `screencapture -v` (works on
runners; see .github/workflows/mac-update-ui.yml for the current
recorder to replace). Pace it naturally; review frames with vision
before sending anything to the owner.

Also: the owner said the second video from run 29209950363's
mac-update-ui artifact ("update-ui.mov") **has a problem he spotted —
undiagnosed**. Download that artifact, extract frames, find it, and
fold the finding into the new recording. (Frames were extracted but
never reviewed before handoff.)

### 3. update-flash-close branch — witness FAILED TO REPRODUCE, investigate
Owner-reported bug: quit with a pending update, reopen immediately →
the app flashes closed ("looks corrupt"). Branch has: the regression
test (reopen immediately after quit-install; end state must be app
RUNNING on the NEW version), and a HOLDING commit 6925b16 with an
UNVALIDATED fix (src/desktop/updateGuard.ts + a main.ts early handoff:
detached PowerShell marquee waits for the installer, then relaunches).
**Witness run 29209714448 PASSED on both windows-update legs — the bug
did not reproduce.** Do not merge. Investigate: read that run's step
log ("reopening immediately; installer visible: …", timings), figure
out why the reopened app survived (installer already finished? NSIS
graceful-close closed it and something relaunched? single-instance
interplay?), find the owner's real repro conditions (maybe: reopen via
double-clicked FILE, multiple windows, or the window between
quit-request and installer spawn), make the witness genuinely red,
then validate or revise the held fix.

### 4. Verify the queue, then release v0.5.12
The runner queue was ~15 deep at handoff; every main run should end
green (branch witness runs are intentionally red: 29207150291,
29209862293, and 29206505841/29206172451 were flakes whose reruns
must be green — the underlying causes are already fixed by the
uninstall-drain hardening and the preview fix). Codecov is live
(96.18%, README badge renders). When main is fully green and branches
1 and 3 are resolved, ship v0.5.12 per the release rules. CHANGELOG
user-facing entries to include: documents no longer wear the app icon
(macOS composes native document icons; Windows gets page+logo+label
icons); new app icon (the trail on a dark squircle, identical on mac,
Windows, and the web); standard installer/uninstaller icons; native
dark scrollbars (rail and arrow buttons are back on Windows); windows
opened for a document never flash empty (derived-title fix); the hover
preview opens reliably during page re-renders; README logo + CI and
coverage badges. Add whatever lands from items 2–3. Verify after
publish: dash-named assets, updater URLs return 200, deploy-web green.

## Recent context (already merged/delivered)
v0.5.11 is the released version. Since then on main: derived-title
no-flash fix; per-type document icons (mac afterPackMac strips
CFBundleTypeIconFile so LaunchServices composes; win drawn template);
plated app icon everywhere; NSIS stock installer icons; native
scrollbars; core-gap unit tests + parseProgress hardening; c8 coverage
+ Codecov via OIDC; CI on every branch push; review workflows
(mac-screenshot, windows-file-icons, mac-scrollbar, mac-update-ui) —
all dispatched manually, reviewed with vision, artifacts sent to the
owner. Transcripts of sessions 1–3 are in docs/transcripts/.
