---
name: test-immutability
description: "Tests are IMMUTABLE contracts — never edit existing test code without owner permission; \"Test Deletion\" commit-message protocol"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Tests are contracts the owner enforces onto the project; the agent may
not change a contract unilaterally — only the owner has that right
(owner's words; they halted a suite-parametrization refactor over it).

**How to apply:**
- Never edit/modify existing test CODE — only ADD tests. "DRY does not
  apply to tests": duplicate suites rather than share/parametrize.
- ADDING tests is always fine, needs no permission, may mix into
  normal commits. Renaming a test or editing test comments is fine —
  only test code is guarded.
- If a change requires a test to change: finish ALL requested work
  with the test failing, STOP, ask permission.
- Red (-) lines over a test file are allowed for exactly ONE reason —
  a test is failing that should not be (the test itself is wrong) —
  and ALWAYS require the owner's explicit permission first (covers
  uncommitted just-added test code too). Needing different logic in a
  test = write a NEW test, never patch.
- Any commit whose diff has red (-) lines in a test file MUST start
  its commit message with "Test Deletion", and test modifications/
  deletions go in commits containing ONLY test changes.
- Non-test tooling (media/icons/perf/fixture generators) lives in
  src/tools/, not src/test/.
- See [[flakes-are-bug-reports]], [[ci-testing]].
