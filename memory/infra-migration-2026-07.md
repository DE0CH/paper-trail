---
name: infra-migration-2026-07
description: "2026-07 infra migration — repo moved to de0ch-org, CI moving to Depot runners, Codecov needs re-linking; browser-only blockers must be escalated not hacked"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Infra migration in progress (owner-driven, 2026-07-13). Three moving
parts, all with browser-only steps the owner handles separately:

1. **Repo moved to a GitHub org**: `de0ch/paper-trail` →
   `de0ch-org/paper-trail` (managed runners are org-only). Git remote
   already repointed; old URL redirects. Update hardcoded
   `DE0CH/paper-trail` refs: README badges + Releases link, docs, the
   About-box copyright in src/desktop/main.ts, Toolbar.tsx.

2. **CI → Depot runners**. Label mapping (do the runs-on swap in-branch;
   sizes/choices are the agent's):
   - Linux ubuntu-* → `depot-ubuntu-24.04` (append `-8`/`-16` for heavy;
     `depot-ubuntu-latest` also works).
   - macOS macos-latest/15/14 → `depot-macos-latest` (=macos-15) or
     `depot-macos-14`. Capacity NOT fully elastic (Apple licensing) —
     occasional QUEUEING is expected, not a fault.
   - Windows windows-latest/2022 → `depot-windows-2025` /
     `depot-windows-latest` / `depot-windows-2022`. Depot Windows has
     NO Hyper-V (AWS EC2) — keep any job needing nested virtualization
     on github-hosted.
   - NO Depot equivalent for the arch-specific legs `windows-11-arm`
     and `macos-15-intel` → keep those github-hosted.
   - Takes effect only after the org "Allow public repositories"
     runner-group toggle is ON (public repo; being enabled separately).
     Until then Depot runs sit queued / no-runner-matching-labels.

3. **Codecov re-linking**: uploads fail with `Repository not found`
   under the new org (ci.yml step is deliberately
   `fail_ci_if_error: true`, owner's explicit choice — do NOT weaken
   it). Blocks main CI green until re-linked. Owner handling separately.

**Browser-only blockers — escalate, don't hack** (owner rule): GitHub
org runner-group settings, the Depot dashboard, Depot GitHub App
permissions, billing/trial — these CANNOT be done from the headless
box. If the first Depot run is stuck on one of these (no runner, label
mismatch, auth/runner-group rejection, billing), do NOT loop-retry or
work around it. Write the exact required action (what to click/enable
and why) into an owner-visible doc (handoff/report on main, or
docs/tauri-report/ on the tauri branch) and ask the human (Windows
Claude-in-Chrome or owner) to intervene. Fix freely anything in YAML /
labels / git / gh. See [[release-engineering]], [[ci-testing]].
