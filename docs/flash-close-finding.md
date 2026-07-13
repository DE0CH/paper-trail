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

## Decision (owner, 2026-07-13)
**Relax the contract — and make it SILENT.** A reopen that lands mid-
install must **cancel/defer the update and bring up the OLD version
silently**: no flash-close, no marquee, no error. The app opens the
double-clicked document on the currently-installed (old) version; the
downloaded update stays cached and applies on the next clean quit.

Consequences:
- The held fix's **"Updating Paper Trail…" marquee is dropped** — the
  handoff must be silent (updateGuard.ts).
- The reopen must cancel the pending install **cleanly** (no half-
  replaced/corrupt files); the app's files must remain the intact old
  version. The old-version outcome the held fix already reaches is
  correct — this just removes the marquee and stops treating "the
  update didn't complete" as a failure.
- The witness's **"the update still completes" assertion is relaxed**
  (owner granted this test-contract change): assert instead no flash-
  close (app runs), the document opens, the app is the OLD version
  (update deferred, not lost), and no corrupt/partial install.

## Status
- **Cut from v0.5.13** (shipped without it; v0.5.12 was skipped). The
  release shipped the other tracks (Sparkle update window + cancel,
  mac/win resilience tests, .ptl-then-PDF save-binding fix).
- The decision above is now made — implementing the **silent cancel/
  defer** path: reopen mid-install → old version + document, no marquee,
  update deferred to next quit, and relaxing the witness accordingly.
- Branch `update-flash-close` holds the reliable RED witness + focused
  `witness-flash-close.yml`; `update-flash-close-fixed` holds the (now
  superseded) marquee handoff whose safe old-version outcome is the base
  to make silent. The full `ci.yml` witness step is NOT wired for
  release until the silent fix is correct against the relaxed contract.
