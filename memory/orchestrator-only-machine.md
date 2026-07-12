---
name: orchestrator-only-machine
description: "The 4GB main-line box (~/paper-trail-main) is an orchestrator ONLY — no local builds, tests, app runs, or media processing; defer all computation to GitHub Actions"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 66ac1584-fe1c-41ef-b7ba-6a616f203268
---

Owner rule (2026-07-12, after a local OOM crash): the main-line machine
(4GB RAM, ~/paper-trail-main) must be treated as a lightweight
ORCHESTRATOR ONLY.

**Why:** Local builds and media processing OOM-crashed the box.

**How to apply:** Never run locally: `npm run build`, tsc, vite, cargo,
the app itself, ffmpeg/ffprobe, video-frame extraction, or
screenshotting. Local shell use is limited to git, gh, file edits, and
quick metadata. Defer ALL computation to GitHub Actions: edit source
and docs, commit and push, then trigger and watch workflows with gh and
read their logs/artifacts. Media capture AND frame extraction belong in
CI workflows (have the workflow upload extracted frames as artifacts;
view those with the Read tool). Compile checks happen via CI too — this
supersedes the older "compiling locally is fine" note for this box.
Related: [[flakes-are-bug-reports]], tests already run only on runners.
