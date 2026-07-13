// The desktop shell's Software Update window: a Sparkle-style native
// macOS updater window that moves through the standard states —
// checking, up to date, update available, downloading (progress bar),
// ready to restart, error — with a stable button row (fixed-width
// buttons, no layout shift between states). The main process owns the
// real state and pushes it over the ptUpdate bridge; every button is a
// plain request back to it. During a download the secondary button is
// a REAL Cancel that stops the download (main process side).

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './updateWindow.css';

type UpdateUiState =
  | { state: 'checking'; appVersion: string }
  | { state: 'none'; appVersion: string }
  | { state: 'available'; version: string; appVersion: string }
  | { state: 'downloading'; version: string; percent: number; appVersion: string }
  | { state: 'downloaded'; version: string; appVersion: string }
  | { state: 'error'; detail: string; appVersion: string };

type UpdateAction = 'download' | 'cancel' | 'restart' | 'later';

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
      // A real Cancel: it stops the download (main process) and drops
      // back to the offer, not a "Later" that only hides the window.
      return {
        primary: { label: 'Restart to Update', action: 'restart', enabled: false, shown: true },
        secondary: { label: 'Cancel', action: 'cancel', enabled: true, shown: true },
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
  const kind = id === 'pt-update-primary' ? 'pt-upd-btn-primary' : 'pt-upd-btn-secondary';
  return (
    <button
      id={id}
      className={`pt-upd-btn ${kind}`}
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
    <div id="pt-update-root" data-state={s.state} className="pt-upd">
      <img src="/icon.svg" alt="" className="pt-upd-icon" draggable={false} />
      <div className="pt-upd-body">
        <div id="pt-update-title" className="pt-upd-title">{title}</div>
        <div id="pt-update-detail" className="pt-upd-detail">{detail}</div>
        <div className="pt-upd-progress-track"
          style={{ visibility: busy ? 'visible' : 'hidden' }}>
          <div id="pt-update-progress"
            className={s.state === 'checking'
              ? 'pt-upd-progress-bar indeterminate'
              : 'pt-upd-progress-bar'}
            style={s.state === 'downloading' ? { width: `${percent}%` } : undefined}
            data-percent={s.state === 'downloading' ? Math.round(percent) : undefined}
          />
        </div>
        <div className="pt-upd-buttons">
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
