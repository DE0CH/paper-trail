// Locate an installed Chromium-family browser per platform (the test
// tooling drives a separate headless instance; nothing is downloaded).

import * as fs from 'node:fs';

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
  const list = CANDIDATES[process.platform] ?? [];
  const found = list.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(`No Chromium-family browser found for ${process.platform}`);
  }
  return found;
}
