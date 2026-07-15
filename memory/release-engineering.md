---
name: release-engineering
description: "Release process rules (never reuse versions, CI gating, artifact naming), signing/notarization secrets, deploy layout"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

- Published: github.com/DE0CH/paper-trail (public). Vercel prod
  https://paper-trail-green.vercel.app (team-scoped URLs 302 behind
  Vercel auth — expected). Deploys ONLY from release.yml's deploy-web
  job (since 0.5.6), never on push.
- release.yml: v* tags → signed+notarized universal mac zip+dmg,
  unsigned win; job FAILS if signing secrets missing — owner: never
  ship unsigned mac. Windows binaries unsigned; owner leans Azure
  Trusted Signing but undecided.
- Release process (owner rule, 2026-07-12, refined): DEVELOPMENT pushes
  must have their CI pass BEFORE the version bump; then bump and tag
  together — the release workflow's built-in CI gate validates the
  release. Non-release work continues OPTIMISTICALLY: push, dispatch,
  iterate; fix forward on failure.
- NEVER put `[skip actions]`/`[skip ci]` on the version-bump commit a
  release tag points at (the v0.5.14 mess-up, 2026-07-13): GitHub's skip
  directive suppresses EVERY workflow for that commit, including the
  tag-triggered release.yml — so the tag pushes but no release run ever
  appears (silent no-op, not a startup_failure). The version-bump commit
  must run clean (no skip); its main-push CI running redundantly
  alongside release.yml is fine/expected. `[skip actions]` is ONLY for
  intermediate merge commits that no tag references.
- NEVER reuse a version number (owner rule): a version that failed to
  build or was blocked gets SKIPPED — no `git tag -f`, no tag moving.
  Rename the unshipped CHANGELOG section to the new version AND add a
  "## <ver> (skipped)" section recording why.
- Owner pushes concurrently: if a push is rejected AFTER a tag went up,
  cancel the stale release run and ship the next version number.
- Releases gate on the full CI pyramid via workflow_call of ci.yml
  INSIDE release.yml — duplicates the branch-push run; owner explicitly
  prefers self-contained logic over saving runners (rejected the
  wait-for-branch-CI dedup; reverted).
- REUSABLE-WORKFLOW PERMISSION RULE (the v0.5.12 startup_failure): a
  called workflow can't be granted MORE permissions than its caller. If
  ci.yml declares `permissions: id-token: write` (it does — Codecov
  OIDC), then EVERY caller (release.yml) must ALSO grant `id-token:
  write` at its top-level `permissions:`, or GitHub refuses to start the
  release with a bare `startup_failure` (no logs, no failed job). Symptom
  to recognize: `gh run list` shows the release run as `startup_failure`
  the instant it's created. Whenever ci.yml's permissions grow, mirror
  them into release.yml. (A throwaway branch with a minimal
  `uses: ./ci.yml` caller is the fast way to confirm — it flips from
  startup_failure to queued the moment the caller's perms match.)
- ci.yml matrix must be workflow_call-safe: use a STATIC matrix + a
  `runs-on:` expression for owner-keyed runner selection, NOT
  `fromJSON` computed matrices.
- Every release needs a user-facing `## <version>` CHANGELOG section;
  the workflow refuses to build without one and copies it into the
  GitHub Release notes.
- ARTIFACT NAMES MUST NEVER CONTAIN SPACES (the 0.5.x update-404 bug):
  GitHub renames uploaded assets spaces→DOTS while the ymls say
  spaces→DASHES → every published update check 404ed on BOTH platforms;
  the harness feed-server name mapping masked it in CI. Fixed via
  explicit artifactName patterns (package.json build: mac/dmg/nsis/win)
  + src/test/updateFeedNames.ts (yml urls must exist on disk verbatim,
  no spaces), run after every packaging step. Suffixes are
  load-bearing: installerMac globs "-mac.zip", win tests glob
  /Setup.*\.exe$/i, release.yml globs "*-win.zip".
- Signing (2026-07-10): local secrets in ~/paper-trail-signing/ on the
  mac (outside repo): devid.key/.csr/.p12 + p12-password.txt +
  AuthKey_3KNVH5BAC5.p8 (ASC API key, ONE-TIME download, role
  Developer, Key ID 3KNVH5BAC5, Issuer
  11025254-570b-463b-af34-00bf6b0e151e). Cert "Developer ID
  Application: Deyao Chen (S64YL394S3)" expires 2031-07-11. GH secrets:
  MAC_CERT_P12 (base64), MAC_CERT_PASSWORD, APPLE_API_KEY_P8,
  APPLE_API_KEY_ID, APPLE_API_ISSUER, VERCEL_*. The five mac signing
  secrets are ALSO set on the private mirror de0ch-org/paper-trail-mirror
  (2026-07-15), so Depot dev builds sign+notarize; VERCEL_* stay
  origin-only. Notarization via electron-builder mac.notarize:true +
  APPLE_API_* env.
- Auto-update live since 0.5.0 (electron-updater, GitHub provider;
  release assets must include latest*.yml + *.blockmap). Test seams:
  PT_UPDATE_URL (generic feed + forceDevUpdateConfig),
  PT_UPDATE_TEST=download|install. Menu item id 'check-updates'.
- act workflow testing: `act -P macos-latest=-self-hosted` (mac box).
- See [[shipped-versions]], [[ci-testing]].
