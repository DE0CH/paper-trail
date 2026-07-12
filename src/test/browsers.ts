// Locate the browser the test tooling drives (a separate headless
// instance — never the owner's browser). Playwright's version-pinned
// Chromium is preferred so every machine and CI runner renders with
// the SAME browser build; an installed Edge/Chrome is the fallback
// where that build isn't available (e.g. Windows on ARM).

import * as fs from 'node:fs';
import { chromium } from 'playwright-core';

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ],
};

export function findBrowser(): string {
  try {
    const pinned = chromium.executablePath();
    if (pinned && fs.existsSync(pinned)) return pinned;
  } catch { /* pinned build not installed for this platform */ }
  const list = CANDIDATES[process.platform] ?? [];
  const found = list.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`No Chromium-family browser found for ${process.platform}`);
  }
  return found;
}
