---
name: flakes-are-bug-reports
description: A sometimes-failing test is a bug report — root-cause it and pin it with a deterministic test
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3a704d83-496d-4972-9d70-7cd1f813a0f9
---

When a test fails sometimes, investigate the failure and write a
proper (deterministic) test that covers it — never just rerun and move
on (owner, 2026-07-12).

**Why:** Timing-dependent failures hide real bugs: the intermittent
osOpenFlash failure was a genuine reveal bug (Electron's URL-derived
page-title-updated events firing early on fast machines) that only a
synthesized-event test (osOpenDerivedTitle) could pin deterministically.
Reruns just resample the race.

**How to apply:** On any intermittent CI failure: (1) read the failing
assertion and reconstruct the race/condition; (2) find the root cause
in the code, not the test; (3) write a NEW deterministic test that
forces the failing condition (synthesize the event, control the
ordering), witness it fail, fix, watch it pass — the standard TDD
cycle. A rerun is only for unblocking the pipeline while the
investigation proceeds, and the investigation is mandatory.
