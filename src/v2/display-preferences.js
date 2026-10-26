import { browserTimeZone } from '../../shared/member-preferences.js';

export const DISPLAY_TIME_ZONE_KEY = 'nb-display-time-zone';
export function validTimeZone(value) {
  if (!value) return '';
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return value; } catch { return ''; }
}
function savedZone() {
  try { return validTimeZone(globalThis.localStorage?.getItem(DISPLAY_TIME_ZONE_KEY)); } catch { return ''; }
}
let preferredZone = savedZone();
const listeners = new Set();
export const automaticTimeZone = () => !preferredZone;
export const displayTimeZone = () => preferredZone || browserTimeZone();
export const displayTimeZoneSnapshot = () => `${preferredZone}|${displayTimeZone()}`;
const notify = () => listeners.forEach(listener => listener());
export function setDisplayTimeZone(value = '') {
  if (value && !validTimeZone(value)) throw new RangeError('Invalid display time zone');
  preferredZone = value;
  try {
    if (value) globalThis.localStorage?.setItem(DISPLAY_TIME_ZONE_KEY, value);
    else globalThis.localStorage?.removeItem(DISPLAY_TIME_ZONE_KEY);
  } catch { /* Keep this tab usable when storage is blocked. */ }
  notify();
}
function refresh(event) {
  if (event?.type === 'storage') {
    if (event.key !== DISPLAY_TIME_ZONE_KEY && event.key !== null) return;
    preferredZone = savedZone();
  }
  notify();
}
export function subscribeDisplayTimeZone(listener) {
  if (!listeners.size) {
    for (const event of ['focus', 'pageshow', 'storage']) globalThis.addEventListener?.(event, refresh);
    globalThis.document?.addEventListener('visibilitychange', refresh);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      for (const event of ['focus', 'pageshow', 'storage']) globalThis.removeEventListener?.(event, refresh);
      globalThis.document?.removeEventListener('visibilitychange', refresh);
    }
  };
}
