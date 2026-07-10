// Platform-aware modifier-key name for user-facing keyboard hints:
// "Cmd" on macOS, "Ctrl" everywhere else. (Handlers already accept both
// metaKey and ctrlKey; this is only about what we *display*.)
export const IS_MAC = /Mac|iPhone|iPad/.test(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent,
);
export const MOD = IS_MAC ? 'Cmd' : 'Ctrl';
