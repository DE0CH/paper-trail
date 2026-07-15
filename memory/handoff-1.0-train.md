---
name: handoff-1.0-train
description: Session-4→5 handoff — v1.0.0 release train state, pending merges, post-1.0 queue (Chrome video, repo watch)
metadata:
  type: project
---

Owner restarted the session mid-train (2026-07-15) to attach Claude in
Chrome. State at handoff; DELETE this file once 1.0.0 has shipped and
the queue below is empty.

**v1.0.0 train (task #37), in order:**
1. Main gate for ac6ac5c (run 29427293217) was in flight — verify green.
   Main = unbreak (hover overlay flush 26px; dblclick-rename fixed) + docs
   pass. If red, fix forward first.
2. Merge `ui-alignment-audit` (verified done: 5 measured fixes,
   red→green, screenshots; branch on both remotes at 1ca6344 — it
   contains a merge of the BROKEN df187c1 main, so after merging into
   fixed main its inherited failures vanish; expect a small Sidebar.tsx
   reconcile with the 26px overlay comment).
3. Merge `installer-shortcut-choices` when its agent reports (desktop +
   Start-Menu checkbox page, both default-checked; silent installs
   unchanged; was told to validate Windows-scoped on origin).
4. CHANGELOG ## 1.0.0 from [[draft-changelog-1.0.0]] (memory/
   draft-changelog-1.0.0.md — trim the installer-checkbox bullet if that
   branch missed the train), bump package.json to 1.0.0, signed tag
   v1.0.0, push, watch release.yml green, AND dispatch a parallel dev
   build (owner wants early review before the release pipeline ends).
5. PushNotification on the published release. NEVER reuse a version.

**Post-1.0 queue:**
- Flip the owner's repo subscription to watch-all:
  `gh api -X PUT /repos/de0ch/paper-trail/subscription -F subscribed=true`
  (currently ignored:true — verified).
- README demo video URL via CLAUDE IN CHROME (available after restart):
  upload docs/media/demo.mp4 (main, commit 9036506) into a NEW GitHub
  issue, grab the user-attachments URL, abandon the issue, replace the
  URL at README.md:22, verify the player. See [[media-pipeline]].
- 1.0 POLICY NOW ACTIVE: strict .ptl backward compatibility + migrations
  for every format change (CLAUDE.md).
- Session-4 transcript: docs/transcripts/session-4-66ac1584.jsonl.gz.
- Re-arm a 10-minute anti-stuck recurring heartbeat (owner standing
  order; crons are session-only).

**Known noise/pins:** save-picker suite can't run on Depot mac or
win-arm (env; auto-skips); one intel save-fails flake (greened on
rerun); mirror = Depot validation for feature branches, main = GitHub.
