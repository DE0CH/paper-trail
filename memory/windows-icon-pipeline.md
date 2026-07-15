---
name: windows-icon-pipeline
description: "Windows .ico generation gotchas — multi-res via png2icons forWinExe; .pdf is Edge-owned so the file-icon workflow's association capture shows Edge's stock icon, not ours"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2e27943c-74f2-4759-88b8-516468621ccc
---

Settled 2026-07-14 (branch `installer-pdf-icons`, off main e7487c5).

**Multi-resolution ICOs.** `src/tools/icons.ts` builds every Windows
`.ico` with `png2icons.createICO(png, BICUBIC2, 0, false, true)` — the
`forWinExe=true` mix (BMP at 16/24/32/48, PNG above). This REPLACED the
old ffmpeg single-256 `.ico`, which rendered BLANK/stock at small
list/details sizes and (crucially) as the installer `.exe`'s own file
icon in Explorer. Multi-res fixed "the installer has no file icon in
Explorer." Bonus: files shrank ~270KB → ~33KB (PNG-compressed 256 vs the
old uncompressed 256 BMP). Generation is now pure JS (png2icons + a
headless playwright render), so a Windows CI job regenerates the `.ico`
with no ffmpeg and no Mac; only `.icns` still needs sips/iconutil, now
guarded to `process.platform === 'darwin'`.

**`.pdf` is owned by Microsoft Edge.** In `windows-file-icons.yml` the
shell-icon capture (`win-icon-pdf.png`) shows EDGE's stock red-PDF icon,
NOT ours — the Explorer details view even types it "Microsoft Edge PDF
Document." Deleting the per-user UserChoice key falls back to the
machine `HKCR\.pdf` default, which is Edge, not Paper Trail. Our
`pdf.ico` only displays once a user picks "Always open with Paper
Trail." So the association capture is misleading for `.pdf`. To see the
icons we actually SHIP, the workflow now has a "Render each .ico
directly" step (artifact `ico-renders`, e.g. `ico-pdf-256.png`) that
loads `build/*.ico` via `System.Drawing.Icon` — association-independent
ground truth. `.ptl` (our own extension, no competitor) DOES render our
icon through the association path.

**Designs.** Installer = a kraft shipping box filling the canvas (the
old one sat in blank space) with the plated trail badge on the front.
`.pdf` = white page + folded corner + red "PDF" band + the plated trail
badge in the top-left corner (reads as a PDF, still branded). `.ptl` =
the page wearing the centered plated logo + "PTL" label (unchanged).

Verified on windows-latest, run 29303613558. See [[ci-testing]],
[[desktop-shell]]. NOTE: Windows-interactive screenshot jobs can't run
on Depot (no interactive desktop) — always windows-latest.
