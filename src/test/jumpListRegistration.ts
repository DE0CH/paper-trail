// Right-clicking the taskbar icon must actually offer "New Window".
// Registering the Jump List task is not enough: Windows attaches a
// custom Jump List to the taskbar button only when the running app's
// AppUserModelID matches the one the installer stamps on the
// shortcuts (the appId). 0.5.8 registered the task but never set the
// id, so the menu never showed it. This harness spies on both calls:
// the app must set the exact appId AND register a tasks category
// whose New Window entry relaunches this executable with
// --new-window.
// Run (CI, Windows): npx electron build-node/test/jumpListRegistration.js

process.env.PT_USERDATA = process.env.PT_USERDATA
  ?? require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt-jumplist-'));
process.env.PT_SHOT = '1'; // show without stealing focus

import * as path from 'node:path';
import { app } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const APP_ID = (require(path.resolve(__dirname, '..', '..', 'package.json')) as {
  build: { appId: string };
}).build.appId;

// Spy before the shell runs: record what identity and Jump List the
// app registers (the real calls still go through).
let modelId = '';
const realSetId = app.setAppUserModelId.bind(app);
(app as { setAppUserModelId: unknown }).setAppUserModelId = (id: string) => {
  modelId = id;
  realSetId(id);
};
interface JumpCategory {
  type?: string;
  items?: Array<{ type?: string; title?: string; program?: string; args?: string }>;
}
let jumpList: JumpCategory[] | null = null;
const realSetJump = app.setJumpList?.bind(app);
(app as { setJumpList: unknown }).setJumpList = (cats: JumpCategory[]) => {
  jumpList = cats;
  realSetJump?.(cats as Electron.JumpListCategory[]);
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

void app.whenReady().then(() => {
  setTimeout(() => {
    check('the app sets its AppUserModelID to the installer appId',
      modelId === APP_ID, modelId || '(never set)');

    const tasks = (jumpList ?? [])
      .filter((c) => c.type === 'tasks')
      .flatMap((c) => c.items ?? []);
    const newWindow = tasks.find((t) => t.type === 'task' && t.title === 'New Window');
    check('the Jump List registers a New Window task',
      !!newWindow, JSON.stringify(tasks));
    check('the task relaunches this executable with --new-window',
      newWindow?.program === process.execPath && newWindow?.args === '--new-window',
      JSON.stringify({ program: newWindow?.program, args: newWindow?.args }));

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    app.exit(failed.length ? 1 : 0);
  }, 10_000);
});
