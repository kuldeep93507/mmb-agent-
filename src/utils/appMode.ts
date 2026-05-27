/** Packaged Electron loads the UI from file:// — dev uses http://localhost */
export function isPackagedElectron(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.protocol === 'file:';
}

/** Local dev in browser or Electron dev server */
export function isDevLocalhost(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}
