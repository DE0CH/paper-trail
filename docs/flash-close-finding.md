# update-flash-close: finding & open decision (2026-07-13)

The Windows "reopen during a quit-install" bug (owner report: quit with a
pending update, reopen immediately → app "flashes closed / looks
corrupt") was taken through strict witness-first TDD. The witness
(`src/test/updateWinOpenDuringInstall.ts`, on branch `update-flash-close`)
now reproduces reliably and terminates in bounded time.

## What TDD proved
- **RED** (fix reverted, `update-flash-close`): after the mid-install
  reopen, the reopened app ends up `running=false` (flash-closed) and the
  document doesn't open. Bug reproduces.
- **GREEN attempt** (held fix `6925b16` re-applied + a PowerShell
  `Start-Process -ArgumentList` arg-quoting fix): the spaced-name document
  now **opens** (the quoting bug was real and is fixed) and the app stays
  running — **but the update never completes; the app stays on the OLD
  0.5.11.** Identical with 10, 2, and 1 reopen — not a timing artifact.

## Deeper bug the witness caught
The reopen's Electron process **locks the app `.exe`** during its startup
(the ~1.5 s while `handoffWhileUpdating` runs its `tasklist` retries).
NSIS can't replace the locked exe, so the install **aborts**, and the
fix's "Updating…" marquee then relaunches the **old** version. The held
fix trades the flash-close crash for a *silently-skipped update*.

## Open decision (owner)
1. **Refine the fix (keep the strong contract "update still completes").**
   Make the reopen release the exe fast and/or have the marquee VERIFY the
   install succeeded and RE-RUN the pending installer (from the updater
   cache) after our process has exited, then relaunch the new version. A
   fork is attempting this.
2. **Relax the contract.** Accept "reopen during install → app runs the
   OLD version with the document, update defers to the next quit" (no
   crash, no data loss). If chosen, the witness's "update still completes"
   assertion is too strong and would be relaxed — a TEST-CONTRACT change
   requiring the owner's explicit permission.

## Status
- **Cut from v0.5.12** (unvalidated fix — not shipped). v0.5.12 ships the
  other four tracks (Sparkle update window + cancel, mac/win resilience
  tests, .ptl-then-PDF save-binding fix).
- Branch `update-flash-close` holds the reliable RED witness + focused
  `witness-flash-close.yml`; the fix stays reverted there. Fix attempts
  live on throwaway `-green*` branches. The full `ci.yml` witness step is
  NOT wired for release until the fix is correct.
