---
name: continuous-dev-builds
description: Owner wants a fresh signed dev build + phone notify after every feature/fix lands
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Continuously produce a dev build as features/fixes come in: after each
one merges to `main`, dispatch `dev-build.yml` (workflow_dispatch on
`main`) and PushNotification the owner with the download link. Don't wait
to batch — one dev build per landing.

**How:** `gh workflow run dev-build.yml --ref main --repo de0ch/paper-trail`.
It emits FIVE artifacts (owner's exact set): `pt-mac-dmg`, `pt-mac-zip`,
`pt-win-x64-app`, `pt-win-arm64-app`, `pt-win-installer` (one combined
installer, both arches). **macOS is SIGNED + NOTARIZED** (App Store
Connect API — MAC_CERT_P12/MAC_CERT_PASSWORD + APPLE_API_KEY_P8/
APPLE_API_KEY_ID/APPLE_API_ISSUER secrets, same as release.yml); Windows
stays unsigned. No CI gate on the dev build.

**Why:** the owner examines each build hands-on to verify fixes (the
release CI is desktop-e2e-flaky, so dev builds are the fast feedback loop).

Owner rule this session: "don't ask questions — proceed as best you can
to get me the dev build, ask about changes later if needed."
