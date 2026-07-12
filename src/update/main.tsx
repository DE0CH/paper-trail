// The desktop shell's Software Update window: one fixed-size window
// that moves through the standard update states — checking, up to
// date, update available, downloading (progress bar), ready to
// restart, error — with a stable button row (fixed-width buttons, no
// layout shift between states). The main process owns the real state
// and pushes it over the ptUpdate bridge; every button is a plain
// request back to it.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../ui/globals.css';

type UpdateUiState =
  | { state: 'checking'; appVersion: string }
  | { state: 'none'; appVersion: string }
  | { state: 'available'; version: string; appVersion: string }
  | { state: 'downloading'; version: string; percent: number; appVersion: string }
  | { state: 'downloaded'; version: string; appVersion: string }
  | { state: 'error'; detail: string; appVersion: string };

type UpdateAction = 'download' | 'restart' | 'later';

declare global {
  interface Window {
    ptUpdate?: {
      onState: (cb: (s: UpdateUiState) => void) => void;
      action: (a: UpdateAction) => void;
    };
  }
}

function texts(s: UpdateUiState): { title: string; detail: string } {
  switch (s.state) {
    case 'checking':
      return {
        title: 'Checking for updates…',
        detail: `You have Paper Trail ${s.appVersion}.`,
      };
    case 'none':
      return {
        title: 'You’re up to date',
        detail: `Paper Trail ${s.appVersion} is the latest version.`,
      };
    case 'available':
      return {
        title: 'A new version of Paper Trail is available',
        detail: `Paper Trail ${s.version} is now available — you have `
          + `${s.appVersion}. Would you like to update now?`,
      };
    case 'downloading':
      return {
        title: `Downloading Paper Trail ${s.version}…`,
        detail: 'You can keep reading while it downloads.',
      };
    case 'downloaded':
      return {
        title: 'Ready to update',
        detail: `Paper Trail ${s.version} will be installed when it restarts.`,
      };
    case 'error':
      return { title: 'Update check failed', detail: s.detail };
  }
}

interface ButtonSpec { label: string; action: UpdateAction; enabled: boolean; shown: boolean }

function buttons(s: UpdateUiState): { primary: ButtonSpec; secondary: ButtonSpec } {
  const later: ButtonSpec = { label: 'Later', action: 'later', enabled: true, shown: true };
  const ok: ButtonSpec = { label: 'OK', action: 'later', enabled: true, shown: true };
  switch (s.state) {
    case 'checking':
      return {
        primary: { label: 'Update Now', action: 'download', enabled: false, shown: true },
        secondary: { ...later, label: 'Cancel' },
      };
    case 'none':
      return { primary: ok, secondary: { ...later, shown: false } };
    case 'available':
      return {
        primary: { label: 'Update Now', action: 'download', enabled: true, shown: true },
        secondary: later,
      };
    case 'downloading':
      return {
        primary: { label: 'Restart to Update', action: 'restart', enabled: false, shown: true },
        secondary: later,
      };
    case 'downloaded':
      return {
        primary: { label: 'Restart to Update', action: 'restart', enabled: true, shown: true },
        secondary: later,
      };
    case 'error':
      return { primary: ok, secondary: { ...later, shown: false } };
  }
}

function Button({ id, spec }: { id: string; spec: ButtonSpec }) {
  const base = 'min-w-32 rounded-md border px-3 py-1.5 text-center transition-colors';
  const kind = id === 'pt-update-primary'
    ? 'border-accent bg-accent text-white enabled:hover:brightness-110'
    : 'border-borderapp bg-hoverrow text-fgapp enabled:hover:bg-panel';
  return (
    <button
      id={id}
      className={`${base} ${kind} disabled:opacity-45`}
      style={spec.shown ? undefined : { visibility: 'hidden' }}
      disabled={!spec.enabled}
      onClick={() => window.ptUpdate?.action(spec.action)}
    >
      {spec.label}
    </button>
  );
}

function UpdateWindow() {
  const [s, setS] = useState<UpdateUiState | null>(null);

  useEffect(() => {
    window.ptUpdate?.onState(setS);
  }, []);

  if (!s) return null;
  const { title, detail } = texts(s);
  const { primary, secondary } = buttons(s);
  const busy = s.state === 'checking' || s.state === 'downloading';
  const percent = s.state === 'downloading' ? Math.max(0, Math.min(100, s.percent)) : 0;

  return (
    <div id="pt-update-root" data-state={s.state}
      className="flex h-full select-none gap-5 p-6">
      <img src="/icon.svg" alt="" className="h-16 w-16 shrink-0" draggable={false} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div id="pt-update-title" className="font-semibold">{title}</div>
        <div id="pt-update-detail"
          className="mt-1 overflow-hidden text-ellipsis text-dim"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
          {detail}
        </div>
        {/* The bar's slot is always reserved so states swap without the
            buttons moving. */}
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full"
          style={{ visibility: busy ? 'visible' : 'hidden' }}>
          <div className="h-full w-full rounded-full bg-borderapp">
            <div id="pt-update-progress"
              className={s.state === 'checking'
                ? 'h-full w-1/4 animate-pulse rounded-full bg-accent'
                : 'h-full rounded-full bg-accent'}
              style={s.state === 'downloading' ? { width: `${percent}%` } : undefined}
              data-percent={s.state === 'downloading' ? Math.round(percent) : undefined}
            />
          </div>
        </div>
        <div className="mt-auto flex justify-end gap-2.5 pt-4">
          <Button id="pt-update-secondary" spec={secondary} />
          <Button id="pt-update-primary" spec={primary} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <UpdateWindow />
  </StrictMode>,
);
