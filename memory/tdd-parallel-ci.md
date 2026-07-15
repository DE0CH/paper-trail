---
name: tdd-parallel-ci
description: "On slow/CI-bound TDD, run the fix-reverted (expect red) and fix-applied (expect green) variants in PARALLEL — don't serialize on watching red first"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Owner rule (2026-07-13): the witness-first TDD order (watch it fail →
apply fix → watch it pass) does NOT require SERIAL CI runs. When the
verdict comes from CI (minutes per run), run both variants CONCURRENTLY:

- one dispatch of the test on the fix-REVERTED state (expect RED),
- one dispatch of the same test with the fix APPLIED (expect GREEN),

on separate branches, triggered at the same time (prefer the Depot
mirror — see [[infra-migration-2026-07]]). The TDD claim is proven when
the red variant fails the target step AND the green variant passes it —
both verdicts in ONE wait instead of two. Then land the fix.

**Why:** halves the wall-clock on CI-bound bug fixes; you no longer
block the fix attempt on first observing the failure.

**Also (owner, 2026-07-13): a FOCUSED single-test workflow.** Don't
iterate one test through the full ci.yml pyramid. Make a
`workflow_dispatch` workflow that runs ONLY the test in question plus
its minimal build/package deps (e.g. a witness-only workflow: build →
package just the installer(s) it needs → run that one test), on the
Depot mirror. Each run becomes build+one-test (a few min) instead of
the whole pyramid. Keep it on the working branch as a dev aid; the
authoritative gate stays the full ci.yml via the release, so it need
not merge to main.

**Per-platform red is mandatory** (owner, 2026-07-13): a bug that
"affects mac and windows" must be witnessed RED on EACH platform
separately — write/run the test on macOS AND on Windows and watch each
go red before the fix, then green after. Never infer "the fix is in
shared code so both are covered"; that's not TDD. If one platform's
"red" run comes back green without the fix, that platform isn't
affected — say so with that evidence.

**How to apply:** still WRITE the test first and confirm it targets the
real bug; just don't gate the fix push on seeing red land — fan the two
runs out together. Also: sanity-check the test TERMINATES in bounded
time (a hung witness — e.g. execFileSync with no timeout against a
frozen/locked installer — blocks forever and defeats the parallelism).
Related: [[flakes-are-bug-reports]], [[test-immutability]].
