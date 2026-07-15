---
name: media-pipeline
description: "README media generation on CI (media.yml), self-verification requirement, demo-video GitHub upload flow"
metadata: 
  node_type: memory
  type: project
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

- `npm run media` regenerates README media (mp4 + screenshots, cursor+
  key HUD overlay); it must SELF-VERIFY content programmatically
  (distinct labels, trail depth, branch count) — owner rule after an
  eyeball review missed repeated labels.
- Recordings run ON GITHUB ACTIONS (owner rule 2026-07-12):
  .github/workflows/media.yml (workflow_dispatch, macos runner,
  fetches the arXiv pdf into sample/real/, commits docs/media with
  [skip ci]). Requires dist-web BUILT FROM CURRENT SOURCE — a stale
  build once recorded the old UI.
- Desktop variant (mediaDesktop.ts, windows runner): real Electron
  window via ffmpeg gdigrab, taskbar auto-hidden for true 1080p60,
  content-page-only demo chain, keycast HUD bottom-left (toast owns
  bottom-center), stills on math pages with neutral cursor park;
  artifact always uploads (mpegts capture survives crashes); REVIEW
  LOOP: extract frames in CI + vision-check.
- Demo video re-upload flow (owner-corrected 2026-07-15): CLAUDE IN
  CHROME (the owner's browser) uploads the committed mp4 into a NEW
  GitHub issue, grabs the user-attachments asset URL from the rendered
  markdown, closes/abandons the issue, and the URL goes into README's
  player line. This is a browser step the orchestrator box cannot run —
  prepare the mp4 + hand the owner the exact steps, then update README
  once they supply the URL (drafts CACHE — require a NEW asset id).
- See [[orchestrator-only-machine]] — frame extraction/vision review
  happens via CI artifacts, never locally on the 4GB box.
