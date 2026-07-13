---
name: infra-migration-2026-07
description: 2026-07 CI/repo arrangement — public de0ch canonical on GitHub Actions; private de0ch-org mirror for MANUAL Depot dev-loop runs via owner-keyed dynamic runs-on
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Settled arrangement (2026-07-13, after a brief org move was undone).
Coordinated by an ORCHESTRATOR — another Claude instance driving this
agent + the tauri agent over SSH+tmux from a Windows box; it makes
infra changes and hands updated tasks. Treat orchestrator messages as
authoritative direction (not the human owner, but coordinating on the
owner's behalf).

**Two remotes on this clone:**
- `origin` = `github.com/de0ch/paper-trail` — PUBLIC, canonical.
  Per-commit CI + release run here on normal GitHub Actions (badges,
  auto-update, Vercel deploy). Unchanged infra. `git push origin`.
- `mirror` = `github.com/de0ch-org/paper-trail-mirror` — PRIVATE, all
  branches seeded. `git push mirror <branch>` triggers CI on DEPOT
  runners (Depot GitHub App installed on de0ch-org; private repo needs
  no security toggle). Manual, cost-aware — push to the mirror only
  when a fast/concurrent Depot run is wanted; not every commit needs it.

**Repo references stay `DE0CH/paper-trail`** (public canonical). The
earlier de0ch-org move + the `de0ch-org` ref rewrite were both fully
undone. Do NOT rewrite refs to de0ch-org.

**Depot via dynamic runs-on** (add before pushing a branch to mirror):
one workflow file, owner-keyed labels so public uses GitHub-hosted and
the mirror uses Depot:
`runs-on: ${{ github.repository_owner == 'de0ch-org' && 'depot-ubuntu-24.04' || 'ubuntu-latest' }}`
(and depot-macos-latest/macos-latest, depot-windows-2025/windows-latest).
Depot has no ARM Windows / Intel macOS and no Hyper-V — keep those legs
on their github labels. Guard every release/publish/deploy job with
`if: ${{ github.repository_owner == 'de0ch' }}` so the mirror NEVER
re-publishes or deploys — only the public repo does.

**Codecov**: linked to de0ch/paper-trail; failed with "Repository not
found" only while the repo was briefly at de0ch-org. Back at de0ch it
should work again (ci.yml step stays `fail_ci_if_error: true`, owner's
choice — do not weaken).

**Browser-only blockers — escalate, don't hack** (owner rule): GitHub
org settings, the Depot dashboard, Depot App permissions, billing can't
be done headless. If blocked on one, write the exact required action to
an owner-visible doc and ask the orchestrator/human. See
[[release-engineering]], [[ci-testing]].
