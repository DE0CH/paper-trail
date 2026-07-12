---
name: existing-components-over-custom
description: Never hand-draw/hand-roll UI where a native or stock component exists — owner rule
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 3a704d83-496d-4972-9d70-7cd1f813a0f9
---

THE THEME: the desktop apps should feel like native apps, and part of
that is using native components. Don't draw or hand-code things
yourself when an existing component exists — the existing one is more
polished and more expected by users (owner, 2026-07-12; also recorded
in CLAUDE.md Design rules).

**Why:** Hand-drawn substitutes lose platform affordances silently:
custom ::-webkit-scrollbar CSS dropped the rail and arrow buttons;
hand-drawn mac document icons displaced Apple's auto-composed ones
(LaunchServices composes app-icon-on-page when CFBundleTypeIconFile is
ABSENT — electron-builder always writes it, so afterPackMac strips it);
a hand-badged installer icon read as the app at small sizes while
NSIS's stock modern-install.ico is the recognized installer look.

**How to apply:** Before drawing/styling any OS-adjacent surface
(scrollbars, icons, dialogs, menus, title bars), find the native or
stock mechanism first (color-scheme, LaunchServices composition, NSIS
Contrib icons, native menus…) and use it; only draw when the platform
truly offers nothing ([[windows-doc-icons]] — Windows has no doc-icon
composition API, so its pdf/ptl icons stay drawn).
